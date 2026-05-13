export interface NewsItem {
  id: number;
  headline: string;
  description: string;
  source: string;
  favicon_char: string;
  favicon_color: string;
  /** ISO date string, e.g. "2026-05-11" */
  published_at: string;
  read_min: number;
  is_ui_update?: boolean;
}

export interface NewsSection {
  id: string;
  title: string;
  /** Short label used in filter pills and card category chips */
  chip_label: string;
  subtitle: string;
  items: NewsItem[];
}

export interface NewsData {
  /** ISO datetime string, e.g. "2026-05-12T10:00:00" */
  updated_at: string;
  /** ISO datetime string for next scheduled issue */
  next_issue_at: string;
  schedule: string;
  sections: NewsSection[];
}
