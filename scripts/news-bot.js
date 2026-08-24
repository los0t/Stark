// scripts/news-bot.js
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

const CONFIG = {
  MAX_ARTICLES: 35,
  MIN_SOURCES: 1,
  MODEL: 'gemini-3.6-flash',
  MAX_CANDIDATES: 1000,
  RSS_FEEDS: [
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC News' },
    { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', source: 'BBC Entertainment & Arts' },
    { url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', source: 'BBC US & Canada' },
    { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', source: 'BBC Business' },
    { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', source: 'BBC Technology' },
    { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', source: 'BBC Science & Environment' },
    { url: 'https://feeds.bbci.co.uk/news/health/rss.xml', source: 'BBC Health' },
    { url: 'https://www.theguardian.com/world/rss', source: 'The Guardian' },
    { url: 'https://www.theguardian.com/us-news/rss', source: 'The Guardian US' },
    { url: 'https://www.theguardian.com/technology/rss', source: 'The Guardian Technology' },
    { url: 'https://www.theguardian.com/culture/rss', source: 'The Guardian Culture' },
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', source: 'Al Jazeera' },
    { url: 'https://feeds.nbcnews.com/nbcnews/public/news', source: 'NBC News' },
    { url: 'https://feeds.abcnews.com/abcnews/topstories', source: 'ABC News' },
    { url: 'https://www.euronews.com/rss', source: 'Euronews' },
    { url: 'https://news.google.com/rss/search?q=weird+strange+incident+OR+unusual+news&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=celebrity+OR+youtuber+OR+influencer+news&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=politics+OR+scandal+OR+controversy&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=viral+internet+news+OR+social+media+controversy&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=interesting+world+news&hl=en-US&gl=US&ceid=US:en', source: 'Google News' }
  ]
};

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWSBOT_EMAIL = process.env.NEWSBOT_EMAIL;
const NEWSBOT_PASSWORD = process.env.NEWSBOT_PASSWORD;
const NEWSBOT_UID = process.env.NEWSBOT_UID;

if (!FIREBASE_DB_URL || !FIREBASE_API_KEY || !GEMINI_API_KEY || !NEWSBOT_EMAIL || !NEWSBOT_PASSWORD || !NEWSBOT_UID) {
  throw new Error('必要な環境変数が設定されていません');
}

// Firebase Auth
async function getFirebaseToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: NEWSBOT_EMAIL, password: NEWSBOT_PASSWORD, returnSecureToken: true })
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('Firebase Auth失敗: ' + JSON.stringify(data));
  console.log('✅ Firebase Auth成功');
  return data.idToken;
}

// RSS取得
async function fetchRSS(feed) {
  try {
    const res = await fetch(feed.url, { headers: { 'User-Agent': 'EcstasyNewsBot/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const channel = parsed.rss?.channel;
    if (!channel) throw new Error('RSSパース失敗');
    const rawItems = channel.item;
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
    return items.map(item => {
      let url = typeof item.link === 'string' ? item.link : item.link?._ || '';
      let description = typeof item.description === 'string' ? item.description : item.description?._ || '';
      return { title: item.title || '', url, description, pubDate: item.pubDate || '', source: feed.source };
    }).filter(item => item.title && item.url);
  } catch (e) {
    console.error(`❌ ${feed.source} 取得失敗: ${e.message}`);
    return [];
  }
}

// 既存記事取得
async function getExistingArticles(token) {
  const res = await fetch(`${FIREBASE_DB_URL}/newsArticles.json?auth=${token}`);
  if (!res.ok) throw new Error(`既存記事取得失敗: HTTP ${res.status}`);
  const data = await res.json();
  return data ? Object.values(data) : [];
}

// Geminiで記事生成（座標付き）
async function generateArticles(candidates, existingArticles) {
  const previousTitles = existingArticles.map(a => a.title).filter(Boolean).slice(-100);
  const candidateText = candidates.map((a, i) => `
---候補 ${i + 1}---
媒体: ${a.source}
タイトル: ${a.title}
公開日時: ${a.pubDate}
URL: ${a.url}
概要: ${a.description}
`).join('\n');

  const prompt = `
あなたは「Ecstasy」という日本語SNSのニュース編集AIです。

以下のニュース候補から日本の若者が「何それ！？」と思う最も興味深い出来事を1つ選び、記事を生成してください。

【情報の信頼性】
- 候補記事の情報のみ使用
- 架空の情報を作らない
- 元記事をコピーしない

【ニュース選択の優先順位】
- 海外の珍事件・面白ニュース
- 芸能人・YouTuber・インフルエンサー
- SNSで話題の出来事
- スキャンダル・政治社会
- 「何それ！？」と思わせるもの

【座標について】
そのニュースが発生した国・地域の代表的な緯度経度を指定してください。
国レベルの大まかな位置で構いません。
例：日本→{"lat":35.7,"lng":139.7}、アメリカ→{"lat":38.9,"lng":-77.0}、イギリス→{"lat":51.5,"lng":-0.1}

【過去の記事（重複を避ける）】
${previousTitles.join('\n')}

【ニュース候補】
${candidateText}

【出力形式】
JSONのみ出力。説明文・前置き・Markdownは不要。

{
  "articles": [
    {
      "title": "SNSで思わず読みたくなるタイトル（事実を歪めない）",
      "summary": "400〜700文字の記事本文（何が・いつ・どこで・誰が・なぜ・現在どうか）",
      "category": "海外事件",
      "country": "国名（日本語）",
      "lat": 緯度（数値）,
      "lng": 経度（数値）,
      "sources": [
        { "name": "媒体名", "url": "候補のURL" }
      ]
    }
  ]
}

categoryは「海外事件」「海外ニュース」「政治・社会」「芸能」「YouTuber・インフルエンサー」「スキャンダル」「雑学」「その他」のいずれか。
`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 7000, responseMimeType: 'application/json' }
      })
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error('Gemini API失敗: ' + JSON.stringify(data));

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Geminiから記事が返されませんでした');

  let cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  let result;
  try { result = JSON.parse(cleaned); } catch (e) {
    console.error('JSON解析失敗:', cleaned);
    throw new Error('GeminiのJSON解析に失敗');
  }

  if (!Array.isArray(result.articles)) throw new Error('articlesが配列ではない');
  return result.articles.filter(a => a && a.title && a.summary && Array.isArray(a.sources) && a.lat != null && a.lng != null).slice(0, CONFIG.MAX_ARTICLES);
}

// 出典URL検証
function validateSources(article, candidates) {
  const candidateUrls = new Set(candidates.map(c => c.url));
  return article.sources.filter(s => s && s.name && s.url && candidateUrls.has(s.url)).filter((s, i, arr) => arr.findIndex(x => x.url === s.url) === i);
}

// Firebase投稿
async function postToFirebase(token, article) {
  const now = Date.now();
  const displayTitle = `【${article.title}】`;
  let postText = `${displayTitle}\n\n${article.summary}\n\n📰 出典\n`;
  for (const s of article.sources) postText += `・${s.name}\n${s.url}\n`;

  // スレッド作成
  const threadRes = await fetch(`${FIREBASE_DB_URL}/threads.json?auth=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: displayTitle.slice(0, 100),
      createdBy: '🤖 AI NEWS',
      createdByUid: NEWSBOT_UID,
      createdByNick: '🤖 AI NEWS',
      createdAt: now,
      lastActivity: now,
      postCount: 1,
      isNewsThread: true,
      newsCategory: article.category || 'ニュース',
      country: article.country || '',
      lat: article.lat,
      lng: article.lng
    })
  });
  const threadData = await threadRes.json();
  const tid = threadData.name;
  if (!tid) throw new Error('スレッド作成失敗: ' + JSON.stringify(threadData));

  // 投稿作成
  await fetch(`${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: NEWSBOT_UID,
      userId: 'ai_news',
      userNick: '🤖 AI NEWS',
      text: postText,
      ts: now,
      isNewsPost: true,
      newsUrl: article.sources[0]?.url || '',
      newsSource: article.sources.map(s => s.name).join(', '),
      newsSources: article.sources,
      newsCategory: article.category || 'ニュース'
    })
  });

  // 重複防止
  const sourceKey = article.sources.map(s => s.url).sort().join('|');
  const key = Buffer.from(sourceKey).toString('base64').replace(/[.#$/[\]]/g, '_');
  await fetch(`${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: article.title,
      url: article.sources[0]?.url || '',
      source: article.sources.map(s => s.name).join(', '),
      sources: article.sources,
      category: article.category || 'ニュース',
      country: article.country || '',
      lat: article.lat,
      lng: article.lng,
      postedAt: now,
      tid
    })
  });

  console.log(`✅ 投稿完了: ${displayTitle} (${article.country} ${article.lat},${article.lng})`);
  return tid;
}

// 全スレッド・投稿・記事キャッシュを削除
async function clearAllThreads(token) {
  console.log('🗑️ 既存スレッドを全削除中...');
  const res = await fetch(`${FIREBASE_DB_URL}/threads.json?auth=${token}`);
  const threads = await res.json();
  if (threads) {
    for (const tid of Object.keys(threads)) {
      await fetch(`${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`, { method: 'DELETE' });
      await fetch(`${FIREBASE_DB_URL}/threads/${tid}.json?auth=${token}`, { method: 'DELETE' });
    }
  }
  await fetch(`${FIREBASE_DB_URL}/newsArticles.json?auth=${token}`, { method: 'DELETE' });
  console.log('✅ 全削除完了');
}

// メイン
async function main() {
  console.log('🤖 Ecstasy ニュースBot 開始');
  const token = await getFirebaseToken();

  // 全削除してリフレッシュ
  await clearAllThreads(token);

  const existingArticles = [];
  console.log('📚 既存記事: 0件（リセット済み）');

  let allCandidates = [];
  for (const feed of CONFIG.RSS_FEEDS) {
    const articles = await fetchRSS(feed);
    console.log(`   ${feed.source}: ${articles.length}件`);
    allCandidates = allCandidates.concat(articles);
  }

  // URL重複削除
  const uniqueMap = new Map();
  for (const a of allCandidates) if (!uniqueMap.has(a.url)) uniqueMap.set(a.url, a);
  allCandidates = Array.from(uniqueMap.values()).slice(0, CONFIG.MAX_CANDIDATES);
  console.log(`📰 候補: ${allCandidates.length}件`);

  if (!allCandidates.length) { console.log('⚠️ 候補なし'); return; }

  let articles;
  try {
    articles = await generateArticles(allCandidates, existingArticles);
  } catch (e) {
    console.error(`❌ 記事生成失敗: ${e.message}`);
    throw e;
  }

  console.log(`🤖 ${articles.length}件生成`);
  let posted = 0;

  for (const article of articles) {
    try {
      const validSources = validateSources(article, allCandidates);
      if (validSources.length < CONFIG.MIN_SOURCES) { console.log(`⚠️ 出典不足: ${article.title}`); continue; }
      article.sources = validSources;

      const existingUrls = new Set(existingArticles.map(a => a.url).filter(Boolean));
      if (article.sources.some(s => existingUrls.has(s.url))) { console.log(`⏭️ 重複: ${article.title}`); continue; }

      await postToFirebase(token, article);
      posted++;
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error(`❌ 投稿失敗: ${e.message}`);
    }
  }

  console.log(`🏁 完了: ${posted}件投稿`);
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
