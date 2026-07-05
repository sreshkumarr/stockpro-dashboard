module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');

  try {
    const calls = [];
    const seen = new Set();
    const texts = [];

    // Fetch 3 pages to get more history
    const pages = [
      'https://t.me/s/StockPro_Online',
      'https://t.me/s/StockPro_Online?before=130000',
      'https://t.me/s/StockPro_Online?before=129900',
    ];

    function stripTags(s) {
      return s
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
        .replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
        .replace(/\s+/g,' ').trim();
    }

    function cleanNum(s) {
      return parseFloat(s.toString().replace(/,/g, ''));
    }

    // Fetch all pages
    for (const pageUrl of pages) {
      try {
        const response = await fetch(pageUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });

        if (!response.ok) continue;

        const html = await response.text();

        // Extract text blocks
        const textPattern = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>(?=\s*<\/div>)/gi;
        const timePattern = /datetime="([^"]+)"/gi;

        let tm, tt;
        while ((tm = textPattern.exec(html)) !== null) {
          texts.push(stripTags(tm[1]));
        }
        while ((tt = timePattern.exec(html)) !== null) {
          // matched in order with texts
        }
      } catch (e) {
        continue;
      }
    }

    // Parse all texts
    texts.forEach(txt => {
      const isCall = /POSITIONAL\s+TRADE|SWING\s+TRADE/i.test(txt);
      const isBreakout = /fresh\s+breakout|breakout\s+above/i.test(txt) && !/hit|made|moved/i.test(txt);
      const isWatch = /^Watch\s+[A-Z]/i.test(txt) && /above\s+[\d]/i.test(txt);

      if (!isCall && !isBreakout && !isWatch) return;

      let stock = '', entry = null, sl = null, targets = [], type = 'Positional', hold = 'few days';

      if (/SWING/i.test(txt)) type = 'Swing';
      if (isBreakout) type = 'Breakout';

      // Extract stock name
      const nameM = txt.match(/(?:POSITIONAL\s+TRADE|SWING\s+TRADE)\s+([A-Z][A-Z0-9\s&\.\(\)]+?)\s+(?:Looks\s+Good|ABOVE)/i);
      if (nameM) stock = nameM[1].trim().replace(/\s+/g,' ').toUpperCase();

      if (!stock || stock.length < 2) return;

      const key = stock;
      if (seen.has(key)) return;
      seen.add(key);

      // Extract entry
      const abM = txt.match(/ABOVE\s+([\d,]+\.?\d*)/i);
      if (abM) entry = cleanNum(abM[1]);

      // Extract SL
      const slM = txt.match(/\bSL\s+([\d,]+\.?\d*)/i);
      if (slM) sl = cleanNum(slM[1]);

      // Extract targets
      const ptM = txt.match(/Targets?\s+([\d]+(?:\s*[-–]\s*[\d]+)+)\s*points/i);
      if (ptM && entry) {
        const pts = ptM[1].split(/\s*[-–]\s*/).map(Number).filter(n => n > 0);
        targets = pts.map(p => parseFloat((entry + p).toFixed(2)));
      } else {
        const tM = txt.match(/Targets?\s+([\d,]+\.?\d*(?:\s*[-–]\s*[\d,]+\.?\d*)+)/i);
        if (tM) {
          targets = tM[1].split(/\s*[-–]\s*/)
            .map(s => cleanNum(s))
            .filter(n => n > 0 && (!sl || n > sl));
        }
      }

      const yahooSym = stock.replace(/\s+/g,'').replace(/&/g,'AND').substring(0, 15);

      if (entry) {
        calls.push({
          stock,
          ticker: yahooSym,
          type,
          entry,
          sl: sl || parseFloat((entry * 0.95).toFixed(2)),
          targets: targets.length ? targets : [parseFloat((entry * 1.03).toFixed(2))],
          hold,
          dateCalled: new Date().toISOString().split('T')[0],
          todayHigh: null,
        });
      }
    });

    return res.status(200).json({
      success: true,
      fetchedAt: new Date().toISOString(),
      msgCount: texts.length,
      callCount: calls.length,
      calls: calls.slice(0, 50), // Limit to 50 most recent
      feed: texts.slice(-30),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
