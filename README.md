# Digest

Персональный AI-дайджест новостей для продуктового дизайнера Профи.ру.

Статический сайт на Astro + TypeScript + TailwindCSS. Новости собираются через Google News RSS и структурируются Gemini.

## Стек

- **Astro** — статическая генерация
- **TypeScript** — строгая типизация
- **TailwindCSS** — стили
- **Gemini 2.5 Flash** — отбор, перевод и структурирование новостей
- **Google News RSS** — источник материалов

## Структура

```
src/
  components/       # Header, FilterPills, DigestSection, DigestCard, EmptyState
  layouts/          # BaseLayout.astro
  pages/            # index.astro
  data/             # news.json — данные текущего выпуска
  types/            # news.ts — TypeScript-интерфейсы
  utils/            # dates.ts — форматирование дат
  styles/           # global.css

config/
  sources.json      # RSS-запросы по секциям
  digest-prompt.md  # Редакторский промпт для Gemini

scripts/
  fetch-news.ts     # Пайплайн сбора новостей
```

## Команды

| Команда              | Действие                                      |
| :------------------- | :-------------------------------------------- |
| `npm install`        | Установить зависимости                        |
| `npm run dev`        | Dev-сервер на `localhost:4321`                |
| `npm run build`      | Сборка в `./dist/`                            |
| `npm run fetch-news` | Собрать свежий дайджест и обновить news.json  |

## Настройка

1. Скопируй `.env.example` в `.env`
2. Вставь `GEMINI_API_KEY` из [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
3. Запусти `npm run fetch-news`
4. Запусти `npm run build`

## Пайплайн fetch-news

```
Google News RSS (config/sources.json)
  → дедупликация по заголовку
  → ограничение до 80 статей
  → Gemini (config/digest-prompt.md)
  → валидация JSON
  → src/data/news.json   ← только при успехе
```

При ошибке Gemini или невалидном JSON сайт оставляет предыдущий `news.json` нетронутым.

## Данные (src/data/news.json)

```jsonc
{
  "updated_at": "2026-05-13T10:00:00",   // дата/время в хедере
  "next_issue_at": "2026-05-15T10:00:00", // "через N дней" в футере
  "schedule": "по понедельникам и четвергам",
  "sections": [
    {
      "id": "design",           // design | comp | ai | mp
      "title": "Дизайн продуктов",
      "chip_label": "Дизайн",   // фильтр-пилюли
      "subtitle": "тренды и исследования",
      "items": [                // макс. 6
        {
          "id": 1,
          "headline": "...",
          "description": "...",
          "source": "nngroup.com",
          "favicon_char": "N",
          "favicon_color": "#1CB0F6",
          "published_at": "2026-05-11",
          "read_min": 4,
          "is_ui_update": false
        }
      ]
    }
  ]
}
```
