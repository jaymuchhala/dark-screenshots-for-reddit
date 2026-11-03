#!/usr/bin/env python3
"""Screenshots of well-known sites, as real screens for the classifier. usage: capture.py <data dir>"""
import hashlib, os, sys
from playwright.sync_api import sync_playwright

SITES = """en.wikipedia.org/wiki/Web_browser github.com/microsoft/vscode github.com/explore stackoverflow.com/questions
news.ycombinator.com developer.mozilla.org/en-US/docs/Web/CSS docs.python.org/3/library/os.html stripe.com stripe.com/pricing
vercel.com/pricing notion.so/product linear.app figma.com/pricing slack.com/pricing zoom.us dropbox.com/plans
mailchimp.com/pricing hubspot.com/pricing shopify.com/pricing wordpress.org/plugins gumroad.com producthunt.com
npmjs.com/package/react pypi.org/project/requests crates.io docs.docker.com kubernetes.io/docs/home nodejs.org/en/docs
tailwindcss.com/docs/installation react.dev/learn getbootstrap.com/docs/5.3/forms/overview web.dev/learn nytimes.com
theguardian.com/international bbc.com/news reuters.com apnews.com npr.org arstechnica.com theverge.com techcrunch.com
medium.com substack.com amazon.com/gp/bestsellers ebay.com/deals etsy.com bestbuy.com/site/electronics/top-deals/pcmcat1563299784494.c
ikea.com/us/en walmart.com booking.com airbnb.com maps.google.com translate.google.com support.google.com/chrome
support.apple.com/mac apple.com/mac microsoft.com/en-us/windows learn.microsoft.com/en-us/windows mozilla.org/firefox/new
archive.org gutenberg.org openstreetmap.org weather.gov usa.gov gov.uk irs.gov/forms-instructions who.int/news
coursera.org/browse khanacademy.org duolingo.com w3schools.com/html indeed.com craigslist.org yelp.com tripadvisor.com
imdb.com/chart/top goodreads.com/list/show/1.Best_Books_Ever spotify.com/us/premium paypal.com/us/business""".split()
VIEWS = [(1280, 800), (1920, 1080), (390, 844)]

out = f'{sys.argv[1]}/screen-web'
os.makedirs(out, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch()
    for site in SITES:
        for width, height in VIEWS:
            page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme='light')
            try:
                page.goto(f'https://{site}', timeout=15000, wait_until='domcontentloaded')
                page.wait_for_timeout(2000)
                name = hashlib.sha1(f'{site}{width}'.encode()).hexdigest()[:16]
                page.screenshot(path=f'{out}/{name}-top.jpg', quality=85, type='jpeg')
                page.mouse.wheel(0, height)
                page.wait_for_timeout(600)
                page.screenshot(path=f'{out}/{name}-down.jpg', quality=85, type='jpeg')
            except Exception as e:
                print(site, width, str(e)[:60], flush=True)
            page.close()
    browser.close()
