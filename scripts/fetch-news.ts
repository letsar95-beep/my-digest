#!/usr/bin/env tsx
/**
 * scripts/fetch-news.ts
 *
 * Pipeline:
 *   1. Read config/sources.json
 *   2. Fetch Google News RSS for each query (last DAYS_BACK days)
 *   3. Deduplicate by URL and title prefix
 *   4. Limit to MAX_INPUT articles
 *   5. Send articles + digest-prompt.md to Gemini Flash
 *   6. Validate response JSON
 *   7. Overwrite timestamps + enforce section caps
 *   8. Write to src/data/news.json (only on success)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SOURCES_PATH  = resolve(ROOT, 'config/sources.json');
const PROMPT_PATH   = resolve(ROOT, 'config/digest-prompt.md');
const NEWS_JSON_PATH = resolve(ROOT, 'src/data/news.json');

// ── Constants ────────────────────────────────────────────────────────────────

const DAYS_BACK       = 4;
const MAX_INPUT       = 80;
const MAX_PER_SECTION = 6;
const GEMINI_MODEL    = 'gemini-2.5-flash';

// ── Types ────────────────────────────────────────────────────────────────────

interface SourceSection {
  id: string;
  title: string;
  chip_label: string;
  subtitle: string;
  queries: string[];
}

interface SourcesConfig {
  sections: SourceSection[];
}

interface RawArticle {
  sectionId: string;
  title: string;
  source: string;
  publishedAt: string;
}

interface DigestItem {
  id: number;
  headline: string;
  description: string;
  source: string;
  favicon_char: string;
  favicon_color: string;
  published_at: string;
  read_min: number;
  is_ui_update: boolean;
}

interface DigestSection {
  id: string;
  title: string;
  chip_label: string;
  subtitle: string;
  items: DigestItem[];
}

interface DigestData {
  updated_at: string;
  next_issue_at: string;
  schedule: string;
  sections: DigestSection[];
}

// ── RSS helpers ───────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'item',
});

function buildRssUrl(query: string): string {
  const hasCyrillic = /[а-яёА-ЯЁ]/.test(query);
  const locale = hasCyrillic ? 'hl=ru&gl=RU&ceid=RU:ru' : 'hl=en&gl=US&ceid=US:en';
  const q = encodeURIComponent(`${query} when:${DAYS_BACK}d`);
  return `https://news.google.com/rss/search?q=${q}&${locale}`;
}

function extractSource(item: Record<string, unknown>): string {
  const s = item['source'];
  if (s && typeof s === 'object') {
    const src = s as Record<string, unknown>;
    if (typeof src['#text'] === 'string') return src['#text'];
  }
  if (typeof s === 'string' && s) return s;
  // fall back to link domain
  try {
    return new URL(String(item['link'] ?? '')).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function extractDate(pubDate: unknown): string {
  try {
    return new Date(String(pubDate)).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function fetchRssQuery(
  sectionId: string,
  query: string
): Promise<RawArticle[]> {
  const url = buildRssUrl(query);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; digest-fetcher/1.0)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`  ⚠ HTTP ${res.status} for query: "${query}"`);
      return [];
    }
    const xml = await res.text();
    const parsed = xmlParser.parse(xml) as Record<string, unknown>;
    const channel = (parsed['rss'] as Record<string, unknown>)?.['channel'] as Record<string, unknown> | undefined;
    const items = (channel?.['item'] as unknown[]) ?? [];

    return (Array.isArray(items) ? items : [items]).map((item) => {
      const it = item as Record<string, unknown>;
      // Google News titles often end in " - Source Name" — strip it
      const rawTitle = String(it['title'] ?? '');
      const title = rawTitle.replace(/\s*-\s*[^-]+$/, '').trim() || rawTitle;
      return {
        sectionId,
        title,
        source: extractSource(it),
        publishedAt: extractDate(it['pubDate']),
      };
    });
  } catch (err) {
    console.warn(`  ⚠ Failed "${query}": ${(err as Error).message}`);
    return [];
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicate(articles: RawArticle[]): RawArticle[] {
  const seenTitles = new Set<string>();
  return articles.filter((a) => {
    const key = a.title.toLowerCase().slice(0, 70);
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function formatLocalISO(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Next Monday or Thursday at 10:00 local time */
function nextPublishDate(): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun…6=Sat
  // Days until next Mon(1) or Thu(4)
  const daysMap: Record<number, number> = { 0: 1, 1: 3, 2: 2, 3: 1, 4: 4, 5: 3, 6: 2 };
  const next = new Date(now);
  next.setDate(now.getDate() + daysMap[day]);
  next.setHours(10, 0, 0, 0);
  return next;
}

// ── Gemini ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extract retry-after seconds from a Gemini 429 error message */
function parseRetryDelay(errMsg: string): number {
  const match = errMsg.match(/retry[^"]*"retryDelay":"(\d+)s"/);
  if (match) return parseInt(match[1], 10);
  const simple = errMsg.match(/Please retry in ([\d.]+)s/);
  if (simple) return Math.ceil(parseFloat(simple[1]));
  return 60; // fallback
}

async function callGemini(
  articles: RawArticle[],
  sections: SourceSection[],
  maxRetries = 3
): Promise<DigestData | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY not set — check your .env file');
    return null;
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8');
  const sectionMeta = sections.map(({ id, title, chip_label, subtitle }) => ({
    id, title, chip_label, subtitle,
  }));
  const userMessage = [
    promptTemplate,
    '',
    '## Секции дайджеста',
    JSON.stringify(sectionMeta, null, 2),
    '',
    `## Статьи для обработки (${articles.length} шт.)`,
    JSON.stringify(articles, null, 2),
  ].join('\n');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { responseMimeType: 'application/json' },
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(userMessage);
      const text = result.response.text();
      const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      return JSON.parse(cleaned) as DigestData;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const is429 = msg.includes('429');

      if (is429 && attempt < maxRetries) {
        const delaySec = parseRetryDelay(msg);
        console.warn(`  ⚠ Rate limited. Waiting ${delaySec}s before retry ${attempt + 1}/${maxRetries}…`);
        await sleep(delaySec * 1000);
        continue;
      }

      console.error(`❌ Gemini call failed (attempt ${attempt}):`, msg.split('\n')[0]);
      return null;
    }
  }
  return null;
}

// ── Validation ────────────────────────────────────────────────────────────────

function isValidDigest(data: unknown): data is DigestData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d['sections'])) return false;
  return (d['sections'] as unknown[]).every((s) => {
    const sec = s as Record<string, unknown>;
    return (
      typeof sec['id'] === 'string' &&
      typeof sec['title'] === 'string' &&
      typeof sec['chip_label'] === 'string' &&
      Array.isArray(sec['items']) &&
      (sec['items'] as unknown[]).every((it) => {
        const item = it as Record<string, unknown>;
        return (
          typeof item['headline'] === 'string' &&
          typeof item['source'] === 'string' &&
          typeof item['published_at'] === 'string'
        );
      })
    );
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('📋 Loading sources config…');
  const { sections } = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8')) as SourcesConfig;

  // 1. Fetch all RSS queries
  console.log(`\n📡 Fetching Google News RSS (last ${DAYS_BACK} days)…`);
  const allArticles: RawArticle[] = [];
  for (const section of sections) {
    for (const query of section.queries) {
      process.stdout.write(`  ↳ [${section.id}] "${query}"… `);
      const articles = await fetchRssQuery(section.id, query);
      console.log(`${articles.length} articles`);
      allArticles.push(...articles);
    }
  }

  console.log(`\n📰 Raw total: ${allArticles.length}`);

  // 2. Deduplicate
  const deduped = deduplicate(allArticles);
  console.log(`🔄 After dedup: ${deduped.length}`);

  // 3. Limit input size
  const input = deduped.slice(0, MAX_INPUT);
  console.log(`✂️  Sending to Gemini: ${input.length}`);

  if (input.length === 0) {
    console.error('❌ No articles fetched — check network / RSS sources');
    process.exit(1);
  }

  // 4. Call Gemini
  console.log(`\n🤖 Calling Gemini (${GEMINI_MODEL})…`);
  const rawDigest = await callGemini(input, sections);

  if (!rawDigest) {
    console.log('⚠️  Keeping existing news.json unchanged');
    process.exit(1);
  }

  // 5. Validate schema
  if (!isValidDigest(rawDigest)) {
    console.error('❌ Gemini response failed schema validation');
    console.log('⚠️  Keeping existing news.json unchanged');
    process.exit(1);
  }

  const digest: DigestData = rawDigest;

  // 6. Inject timestamps (never trust Gemini for these)
  const now = new Date();
  digest.updated_at     = formatLocalISO(now);
  digest.next_issue_at  = formatLocalISO(nextPublishDate());
  digest.schedule       = 'по понедельникам и четвергам';

  // 7. Enforce max per section + re-number IDs
  let idCounter = 1;
  for (const section of digest.sections) {
    section.items = section.items.slice(0, MAX_PER_SECTION);
    for (const item of section.items) {
      item.id = idCounter++;
    }
  }

  // 8. Write result
  writeFileSync(NEWS_JSON_PATH, JSON.stringify(digest, null, 2) + '\n', 'utf-8');

  const total = digest.sections.reduce((n, s) => n + s.items.length, 0);
  console.log(`\n✅ Saved ${total} articles across ${digest.sections.length} sections`);
  console.log(`   → src/data/news.json`);
}

main().catch((err: unknown) => {
  console.error('\n💥 Fatal error:', err);
  process.exit(1);
});
