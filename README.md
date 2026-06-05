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

For stores where the category map is concentrated under one menu, focus the crawl on that menu label:

```bash
npm run crawl -- --url https://www.oldstore.com/ --nav-label MenuShop --out ./runs/oldstore
```

You can also seed specific category URLs when a user already knows where the relevant catalog starts:

```bash
npm run crawl -- --url https://oldstore.example --seed-url https://oldstore.example/catalog --out ./runs/oldstore
```

Useful flags:

```text
--url              Required old site URL.
--out              Output directory. Default: ./crawler-output
--max-pages        Max HTML pages to crawl. Default: 300
--max-depth        Max link depth from homepage/nav. Default: 2
--nav-label        Prioritize links under a homepage navigation label, e.g. Shop.
--seed-url         Add a user-selected URL to crawl first. Can be repeated.
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
