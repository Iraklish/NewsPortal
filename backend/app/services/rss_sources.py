"""Seed list of RSS feeds — used to populate the rss_sources table on first run.

Edit this file to change the *defaults*. Live management happens via the API
(rss_sources table). The seeding logic only runs when the table is empty.
"""

RSS_FEEDS: dict[str, list[str]] = {
    "economics": [
        "https://www.ft.com/rss/home",
        "https://www.economist.com/finance-and-economics/rss.xml",
        "https://feeds.reuters.com/reuters/businessNews",
        "https://www.federalreserve.gov/feeds/press_all.xml",
        "https://www.imf.org/en/News/RSS?language=eng",
        "https://www.cnbc.com/id/100003114/device/rss/rss.html",
        "https://www.marketwatch.com/rss/topstories",
        "https://www.investing.com/rss/news.rss",
        "https://www.worldbank.org/en/news/all.rss",
    ],
    "geopolitics": [
        "https://www.foreignaffairs.com/rss.xml",
        "https://feeds.reuters.com/Reuters/worldNews",
        "https://carnegieendowment.org/rss/solr/?fa=publications&types=all",
        "https://www.atlanticcouncil.org/feed/",
        "https://www.lawfaremedia.org/feed",
        "https://warontherocks.com/feed/",
        "https://www.cnas.org/rss",
        "https://www.brookings.edu/topic/foreign-policy/feed/",
        "https://www.csis.org/analysis/feed",
    ],
    "technology": [
        "https://feeds.arstechnica.com/arstechnica/index",
        "https://www.theverge.com/rss/index.xml",
        "https://techcrunch.com/feed/",
        "https://www.wired.com/feed/rss",
        "https://feeds.reuters.com/reuters/technologyNews",
        "https://www.engadget.com/rss.xml",
        "https://www.zdnet.com/news/rss.xml",
        "https://venturebeat.com/feed/",
        "https://feeds.feedburner.com/TechCrunch/startups",
    ],
    "energy": [
        "https://oilprice.com/rss/main",
        "https://www.spglobal.com/commodityinsights/en/rss-feeds/oil-news",
        "https://www.iea.org/news/rss",
        "https://www.eia.gov/rss/todayinenergy.xml",
        "https://www.rigzone.com/news/rss/rigzone_latest.aspx",
        "https://www.power-eng.com/feed/",
        "https://www.greentechmedia.com/rss/all",
        "https://www.upstreamonline.com/rss",
        "https://www.energyintel.com/rss/news",
    ],
    "politics": [
        "https://feeds.reuters.com/Reuters/PoliticsNews",
        "https://www.politico.com/rss/politicopicks.xml",
        "https://thehill.com/news/feed/",
        "https://www.realclearpolitics.com/index.xml",
        "https://feeds.npr.org/1014/rss.xml",
        "https://www.washingtonpost.com/wp-srv/rss/politics/index.xml",
        "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
        "https://www.axios.com/feeds/politics-policy.xml",
        "https://feeds.bbci.co.uk/news/politics/rss.xml",
    ],
    "israel": [
        # English — verified working
        "https://www.timesofisrael.com/feed/",
        "https://blogs.timesofisrael.com/feed/",
        "https://www.jpost.com/rss/rssfeedsheadlines.aspx",
        "https://www.ynetnews.com/Integration/StoryRss3082.xml",
        "https://www.israelnationalnews.com/Rss.aspx",
        "https://themedialine.org/feed/",
        "https://www.israelhayom.com/feed/",
        "https://www.jns.org/feed/",
        "https://forward.com/feed/",
        "https://www.algemeiner.com/feed/",
        "https://worldisraelnews.com/feed/",
        "https://www.inss.org.il/feed/",
        "https://jcpa.org/feed/",
        "https://nocamels.com/feed/",
        "https://www.theyeshivaworld.com/feed/",
        # Hebrew — verified working
        "https://www.ynet.co.il/Integration/StoryRss2.xml",
        "https://rss.walla.co.il/feed/1",
        "https://rss.walla.co.il/feed/3",
        "https://rcs.mako.co.il/rss/news-military.xml",
        "https://www.maariv.co.il/Rss/RssChadashot",
        "https://www.maariv.co.il/Rss/RssCalcalit",
    ],
    "europe": [
        # United Kingdom
        "http://feeds.bbci.co.uk/news/uk/rss.xml",
        "https://feeds.bbci.co.uk/news/business/rss.xml",
        "https://www.theguardian.com/uk/rss",
        "https://www.telegraph.co.uk/rss.xml",
        "https://www.thetimes.co.uk/rss",
        "https://feeds.skynews.com/feeds/rss/uk.xml",
        "https://www.channel4.com/news/feed",
        "https://www.independent.co.uk/rss",
        "https://www.express.co.uk/posts/rss/1/uk",
        # Germany
        "https://www.spiegel.de/international/index.rss",
        "https://www.spiegel.de/schlagzeilen/index.rss",
        "https://www.welt.de/feeds/topnews.rss",
        "https://www.faz.net/rss/aktuell/",
        "https://www.tagesschau.de/xml/rss2/",
        "https://rss.dw.com/rdf/rss-en-ger",
        "https://www.sueddeutsche.de/news?service=rss",
        "https://rss.handelsblatt.com/news/main/news.rss",
        "https://www.zeit.de/index?p=rss",
        "https://www.heise.de/rss/heise-atom.xml",
        "https://www.tagesspiegel.de/contentexport/feed/home",
        "https://www.n-tv.de/rss",
        # France
        "https://www.lemonde.fr/rss/une.xml",
        "https://www.lefigaro.fr/rss/figaro_actualites.xml",
        "https://www.liberation.fr/arc/outboundfeeds/rss/?outputType=xml",
        "https://www.france24.com/fr/rss",
        "https://www.lesechos.fr/rss/rss_une.xml",
        "https://www.latribune.fr/rss/rubriques/actualite.xml",
        "https://www.leparisien.fr/arc/outboundfeeds/rss-all-categories/?outputType=xml",
        "https://www.20minutes.fr/feeds/rss-actu-france.xml",
        "https://www.la-croix.com/RSS/RSS_All",
        "https://www.francetvinfo.fr/titres.rss",
        # Italy
        "https://xml2.corriereobjects.it/rss/homepage.xml",
        "https://www.repubblica.it/rss/homepage/rss2.0.xml",
        "https://www.lastampa.it/rss",
        "https://www.ilsole24ore.com/rss/notizie.xml",
        "https://www.ansa.it/sito/ansait_rss.xml",
        "https://www.ilfattoquotidiano.it/feed/",
        "https://www.ilmessaggero.it/rss/home.xml",
        "https://www.tgcom24.mediaset.it/rss/rss_homepage.xml",
        "https://www.huffingtonpost.it/feeds/index.xml",
        # Spain
        "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada",
        "https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml",
        "https://www.abc.es/rss/feeds/abc_EspanaEspana.xml",
        "https://www.lavanguardia.com/mvc/feed/rss/home",
        "https://www.elconfidencial.com/rss/",
        "https://www.20minutos.es/rss/",
        "https://www.eldiario.es/rss/",
        "https://www.publico.es/rss/",
        "https://cadenaser.com/rss/",
        # Netherlands
        "https://feeds.nos.nl/nosnieuwsalgemeen",
        "https://www.nrc.nl/rss/",
        "https://www.volkskrant.nl/voorpagina/rss.xml",
        "https://www.telegraaf.nl/rss",
        "https://nltimes.nl/rss.xml",
        "https://www.dutchnews.nl/feed/",
        # Sweden
        "https://www.svt.se/rss.xml",
        "https://www.dn.se/rss/",
        "https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/",
        "https://www.thelocal.se/feed/",
        "https://www.svd.se/?service=rss",
        # Norway
        "https://www.nrk.no/toppsaker.rss",
        "https://www.aftenposten.no/rss/",
        "https://www.vg.no/rss/feed",
        "https://www.thelocal.no/feed/",
        # Denmark
        "https://www.dr.dk/nyheder/service/feeds/allenyheder",
        "https://politiken.dk/rss/senestenyt.rss",
        "https://www.berlingske.dk/content/rss",
        "https://www.thelocal.dk/feed/",
        # Finland
        "https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_NEWS",
        "https://www.hs.fi/rss/teasers/etusivu.xml",
        "https://yle.fi/uutiset/rss/uutiset.rss",
        # Poland
        "https://www.tvp.info/rss/news.xml",
        "https://wyborcza.pl/pub/rss/wyborcza_kraj.xml",
        "https://wiadomosci.onet.pl/.feed",
        "https://www.polskieradio.pl/Rss/0.xml",
        "https://notesfrompoland.com/feed/",
        # Czech Republic
        "https://servis.idnes.cz/rss.aspx?c=zpravodaj",
        "https://www.ceskenoviny.cz/sluzby/rss/zpravy.php",
        "https://english.radio.cz/rss",
        # Hungary
        "https://hungarytoday.hu/feed/",
        "https://hvg.hu/rss",
        "https://24.hu/feed/",
        # Romania
        "https://www.romania-insider.com/rss-feeds/news.xml",
        "https://www.digi24.ro/rss",
        "https://adevarul.ro/rss",
        # Greece
        "https://www.ekathimerini.com/feed/",
        "https://www.tovima.gr/feed/",
        "https://www.protothema.gr/rss",
        # Portugal
        "https://www.publico.pt/rss",
        "https://www.dn.pt/rss",
        "https://observador.pt/feed/",
        # Belgium / EU
        "https://www.politico.eu/feed/",
        "https://www.euractiv.com/feed/",
        "https://www.brusselstimes.com/feed",
        "https://www.vrt.be/vrtnws/en.rss.articles.xml",
        "https://www.rtbf.be/info/rss",
        # Austria
        "https://www.orf.at/news.rss",
        "https://www.derstandard.at/rss",
        "https://rss.diepresse.com/index",
        # Switzerland
        "https://www.swissinfo.ch/eng/rss/news",
        "https://www.letemps.ch/rss",
        "https://www.nzz.ch/recent.rss",
        # Ireland
        "https://www.rte.ie/news/rss/news-headlines.xml",
        "https://www.irishtimes.com/cmlink/news-1.1319192",
        "https://www.independent.ie/rss/",
        # Russia
        "https://tass.com/rss/v2.xml",
        "https://www.rt.com/rss/",
        "https://meduza.io/rss2/en/all",
        # Ukraine
        "https://kyivindependent.com/rss/",
        "https://www.pravda.com.ua/rss/",
        "https://www.kyivpost.com/feed",
        "https://www.ukrinform.net/rss/en/",
        # Turkey (transcontinental, included for European edge)
        "https://www.hurriyetdailynews.com/rss",
        "https://www.dailysabah.com/rssfeed/main",
        "https://www.trtworld.com/rss",
        # EU institutions
        "https://feeds.feedburner.com/euobserver/rss",
        "https://www.consilium.europa.eu/en/rss/news",
    ],
    "georgia": [
        # English — verified working
        "https://civil.ge/feed",
        "https://jam-news.net/feed/",
        "https://oc-media.org/feed/",
        "https://investor.ge/feed/",
        "https://caucasuswatch.de/feed",
        "https://primetime.ge/feed",
        # Georgian — verified working
        "https://netgazeti.ge/rss",
        "https://publika.ge/rss",
        "https://frontnews.ge/rss",
        "https://news.ge/rss",
        # Russian — verified working
        "https://sputnik-georgia.ru/export/rss2/archive/index.xml",
        "https://www.newsgeorgia.ge/rss",
    ],
    "world_news": [
        "http://feeds.bbci.co.uk/news/world/rss.xml",
        "https://feeds.reuters.com/Reuters/worldNews",
        "https://www.aljazeera.com/xml/rss/all.xml",
        "https://www.theguardian.com/world/rss",
        "https://feeds.npr.org/1004/rss.xml",
        "https://rss.dw.com/rdf/rss-en-world",
        "https://feeds.skynews.com/feeds/rss/world.xml",
        "https://www.france24.com/en/rss",
        "https://moxie.foxnews.com/google-publisher/world.xml",
    ],
    "russia": [
        # Independent Russian-language and English-language outlets
        "https://meduza.io/rss/all",
        "https://www.themoscowtimes.com/rss/news",
        "https://theins.ru/feed",
        "https://theins.press/en/feed",
        "https://ridl.io/feed/",
        "https://novayagazeta.eu/feed",
        "https://tvrain.tv/export/rss/all.xml",
        "https://holod.media/feed/",
        # State-aligned (kept for situational awareness)
        "https://tass.ru/rss/v2.xml",
        "https://www.rt.com/rss/news/",
        "https://russian.rt.com/rss",
        "https://ria.ru/export/rss2/index.xml",
        "https://www.interfax.ru/rss.asp",
        "https://radiosputnik.ru/export/rss2/index.xml",
        # Mainstream business + general
        "https://www.kommersant.ru/RSS/news.xml",
        "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
        "https://www.vedomosti.ru/rss/news.xml",
        "https://lenta.ru/rss",
        "https://lenta.ru/rss/news",
        "https://www.gazeta.ru/export/rss/first.xml",
        "https://www.mk.ru/rss/news/index.xml",
        "https://www.kp.ru/rss/allsections.xml",
        "https://news.rambler.ru/rss/world/",
        # International coverage in Russian
        "https://feeds.bbci.co.uk/russian/rss.xml",
        "https://rss.dw.com/rdf/rss-ru-news",
    ],
    "ukraine": [
        # Major Ukrainian outlets — Ukrainian, Russian, and English
        "https://www.pravda.com.ua/rss/view_news/",
        "https://www.pravda.com.ua/eng/rss/view_news/",
        "https://www.epravda.com.ua/rss/",
        "https://www.rbc.ua/static/rss/all.rus.rss.xml",
        "https://rss.unian.net/site/news_rus.rss",
        "https://rss.unian.net/site/news_eng.rss",
        "https://rss.unian.net/site/news_ukr.rss",
        "https://www.ukrinform.net/rss/block-lastnews",
        "https://www.ukrinform.ua/rss/block-lastnews",
        "https://www.ukrinform.net/rss/rubric-polytics",
        "https://www.ukrinform.net/rss/rubric-society",
        "https://www.ukrinform.net/rss/rubric-economy",
        "https://www.ukrinform.net/rss/rubric-defense",
        "https://nv.ua/rss/all.xml",
        "https://24tv.ua/rss/all.xml",
        "https://tsn.ua/rss",
        "https://tyzhden.ua/rss",
        "https://glavred.info/rss/news.xml",
        "https://www.dailylviv.com/rss",
        # English-language Ukraine coverage
        "https://euromaidanpress.com/feed/",
        "https://www.eurointegration.com.ua/rss/",
        "https://www.theguardian.com/world/ukraine/rss",
        "https://news.yahoo.com/rss/ukraine",
    ],

    # ── Google News ──────────────────────────────────────────────────────────
    # Uses search-based RSS (stable) — topic-ID feeds are locale-specific and break
    "google_news": [
        # Top Stories (US)
        "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
        # World News
        "https://news.google.com/rss/search?q=world+news&hl=en-US&gl=US&ceid=US:en",
        # Business
        "https://news.google.com/rss/search?q=business+news&hl=en-US&gl=US&ceid=US:en",
        # Technology
        "https://news.google.com/rss/search?q=technology+news&hl=en-US&gl=US&ceid=US:en",
        # Science
        "https://news.google.com/rss/search?q=science+news&hl=en-US&gl=US&ceid=US:en",
        # Health
        "https://news.google.com/rss/search?q=health+news&hl=en-US&gl=US&ceid=US:en",
        # Entertainment
        "https://news.google.com/rss/search?q=entertainment+news&hl=en-US&gl=US&ceid=US:en",
        # Sports
        "https://news.google.com/rss/search?q=sports+news&hl=en-US&gl=US&ceid=US:en",
        # Politics
        "https://news.google.com/rss/search?q=politics+news&hl=en-US&gl=US&ceid=US:en",
    ],

    # ── Yahoo News ───────────────────────────────────────────────────────────
    "yahoo_news": [
        # Finance — Top Stories
        "https://finance.yahoo.com/rss/topstories",
        # Finance — All News
        "https://finance.yahoo.com/news/rssindex",
        # News — US
        "https://news.yahoo.com/rss/us",
        # News — World
        "https://news.yahoo.com/rss/world",
        # News — Politics
        "https://news.yahoo.com/rss/politics",
        # News — Tech
        "https://news.yahoo.com/rss/tech",
        # News — Entertainment
        "https://news.yahoo.com/rss/entertainment",
        # News — Health
        "https://news.yahoo.com/rss/health",
        # News — Science
        "https://news.yahoo.com/rss/science",
        # News — Sports
        "https://news.yahoo.com/rss/sports",
        # News — Business
        "https://news.yahoo.com/rss/business",
    ],

    # ── Bing News ────────────────────────────────────────────────────────────
    # Requires mkt=en-US&cc=US to return English content. Specific multi-word
    # queries avoid Bing routing the request to an HTML category page.
    "bing_news": [
        # Economy
        "https://www.bing.com/news/search?q=economy+markets&format=rss&mkt=en-US&cc=US",
        # Business & Finance
        "https://www.bing.com/news/search?q=business+finance+news&format=rss&mkt=en-US&cc=US",
        # Stock Market
        "https://www.bing.com/news/search?q=stock+market+investing&format=rss&mkt=en-US&cc=US",
        # Technology & AI
        "https://www.bing.com/news/search?q=tech+industry+AI&format=rss&mkt=en-US&cc=US",
        # International News
        "https://www.bing.com/news/search?q=international+news+today&format=rss&mkt=en-US&cc=US",
        # Politics
        "https://www.bing.com/news/search?q=US+politics+congress&format=rss&mkt=en-US&cc=US",
        # Science & Research
        "https://www.bing.com/news/search?q=science+research+discoveries&format=rss&mkt=en-US&cc=US",
        # Health & Medicine
        "https://www.bing.com/news/search?q=health+medicine+research&format=rss&mkt=en-US&cc=US",
        # Sports
        "https://www.bing.com/news/search?q=sports+championship+results&format=rss&mkt=en-US&cc=US",
        # Geopolitics
        "https://www.bing.com/news/search?q=geopolitics+global+conflict&format=rss&mkt=en-US&cc=US",
    ],

    # ── Yandex News ──────────────────────────────────────────────────────────
    "yandex_news": [
        # Main (Russian)
        "https://news.yandex.ru/index.rss",
        # World
        "https://news.yandex.ru/world.rss",
        # Politics
        "https://news.yandex.ru/politics.rss",
        # Business
        "https://news.yandex.ru/business.rss",
        # Finance
        "https://news.yandex.ru/finances.rss",
        # Science
        "https://news.yandex.ru/science.rss",
        # Technology / Computers
        "https://news.yandex.ru/computers.rss",
        # Sports
        "https://news.yandex.ru/sport.rss",
        # Health
        "https://news.yandex.ru/health.rss",
        # Society
        "https://news.yandex.ru/society.rss",
        # Economy
        "https://news.yandex.ru/economics.rss",
    ],

    # ── TipRanks ─────────────────────────────────────────────────────────────
    "tipranks": [
        # All blog posts
        "https://blog.tipranks.com/feed/",
        # Analyst Rankings
        "https://blog.tipranks.com/category/analyst-rank/feed/",
        # Stocks
        "https://blog.tipranks.com/category/stocks/feed/",
        # Market News
        "https://blog.tipranks.com/category/market-news/feed/",
        # Earnings
        "https://blog.tipranks.com/category/earnings/feed/",
        # ETFs
        "https://blog.tipranks.com/category/etfs/feed/",
        # Dividends
        "https://blog.tipranks.com/category/dividends/feed/",
        # Research & Analysis
        "https://blog.tipranks.com/category/research/feed/",
    ],

    # ── Wall Street Journal (WSJ) ─────────────────────────────────────────────
    # All feeds below verified working via feeds.a.dj.com
    "wsj": [
        # US Business
        "https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml",
        # Markets
        "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
        # World News
        "https://feeds.a.dj.com/rss/RSSWorldNews.xml",
        # Opinion
        "https://feeds.a.dj.com/rss/RSSOpinion.xml",
        # Life & Arts
        "https://feeds.a.dj.com/rss/RSSLifestyle.xml",
        # Dow Jones Newswires
        "https://feeds.a.dj.com/rss/RSSWSJD.xml",
    ],

    # ── JP Morgan ─────────────────────────────────────────────────────────────
    # JP Morgan does not publish native public RSS feeds. We use Google News
    # search RSS to surface JP Morgan research, commentary, and corporate news.
    "jpmorgan": [
        # JPMorgan Chase corporate news & press releases
        "https://news.google.com/rss/search?q=JPMorgan+Chase&hl=en-US&gl=US&ceid=US:en",
        # JP Morgan markets & investment outlook
        "https://news.google.com/rss/search?q=JPMorgan+markets+outlook&hl=en-US&gl=US&ceid=US:en",
        # JP Morgan economic analysis & forecasts
        "https://news.google.com/rss/search?q=JPMorgan+economic+analysis&hl=en-US&gl=US&ceid=US:en",
        # JP Morgan asset management insights
        "https://news.google.com/rss/search?q=JPMorgan+asset+management+insights&hl=en-US&gl=US&ceid=US:en",
        # Jamie Dimon commentary & leadership
        "https://news.google.com/rss/search?q=JPMorgan+Jamie+Dimon+strategy&hl=en-US&gl=US&ceid=US:en",
        # JP Morgan research notes & reports
        "https://news.google.com/rss/search?q=%22JP+Morgan%22+research+report&hl=en-US&gl=US&ceid=US:en",
    ],
}


def all_feeds() -> list[tuple[str, str]]:
    """Return flat list of (category, url) tuples for the seed defaults."""
    return [(cat, url) for cat, urls in RSS_FEEDS.items() for url in urls]
