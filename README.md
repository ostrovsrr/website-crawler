    # Collection Redirect Mapper

First-pass crawler for Shopify migration work. It discovers old collection/category URLs from:

- `sitemap.xml` and sitemap indexes
- homepage/navigation links
- shallow internal crawl

It outputs JSON and CSV inventories you can later match against Shopify collections.

## Usage

```bash
npm run crawl -- --url https://oldstore.example --out ./runs/oldstore --max-pages 300 --max-depth 2
```

Useful flags:

```text
--url              Required old site URL.
--out              Output directory. Default: ./crawler-output
--max-pages        Max HTML pages to crawl. Default: 300
--max-depth        Max link depth from homepage/nav. Default: 2
--include-query    Keep query strings in discovered URLs. Default: false
--same-host-only   Only crawl same hostname. Default: true
--timeout-ms       Request timeout. Default: 15000
```

Outputs:

```text
old-collections.json
old-collections.csv
all-pages.json
crawl-summary.json
```

`old-collections.*` contains likely collection/category pages with page metadata:

- URL and path
- status code
- title
- H1
- canonical URL
- breadcrumb-ish text
- matched reason
