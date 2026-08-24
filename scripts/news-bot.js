// scripts/news-bot.js
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

const CONFIG = {
  MAX_ARTICLES: 10,
  MIN_SOURCES: 0,
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

// Geminiで記事を1件生成
async function generateOneArticle(candidates, usedUrls, usedTitles) {
  const unused = candidates.filter(c => !usedUrls.has(c.url));
  if (!unused.length) return null;
  const sample = unused.sort(() => Math.random() - 0.5).slice(0, 30);

  const candidateText = sample.map((a, i) =>
    `[${i+1}] ${a.source}: ${a.title} | ${a.description.slice(0,100)}`
  ).join('\n');

  const prompt = `以下のニュース候補から1つ選んで日本語記事を生成してください。

過去に使ったタイトル（重複禁止）:
${[...usedTitles].slice(-30).join('\n')}

候補:
${candidateText}

以下のJSON形式のみで回答（説明文・コードブロック不要）:
{"title":"タイトル","summary":"200〜400文字の本文","category":"海外事件","country":"国名","lat":35.7,"lng":139.7,"sourceIndex":1}

categoryは「海外事件」「海外ニュース」「政治・社会」「芸能」「スキャンダル」「雑学」「その他」のいずれか。
sourceIndexは選んだ候補の番号(1〜${sample.length})。`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 800 }
      })
    }
  );

  const data = await res.json();
  if (!res.ok) {
    const errMsg = 'Gemini API失敗: ' + JSON.stringify(data);
    if (res.status === 429) throw new Error('429:' + errMsg);
    throw new Error(errMsg);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  let cleaned = text.trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1) return null;
  cleaned = cleaned.slice(first, last + 1);

  try {
    const a = JSON.parse(cleaned);
    if (!a.title || !a.summary || a.lat == null || a.lng == null) return null;
    // sourceIndexから出典を設定
    const idx = (a.sourceIndex || 1) - 1;
    const chosen = sample[Math.min(idx, sample.length-1)];
    a.sources = [{ name: chosen.source, url: chosen.url }];
    return a;
  } catch(e) {
    console.error('JSON解析失敗:', cleaned.slice(0,200));
    return null;
  }
}

// 出典URL検証（緩め：URLが候補になくてもnameがあればOK）
function validateSources(article, candidates) {
  if (!Array.isArray(article.sources)) return [];
  const valid = article.sources.filter(s => s && s.name && s.url);
  if (valid.length > 0) return valid;
  // sourcesが空でも候補から近いものを探して補完
  return [];
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

  const usedUrls = new Set();
  const usedTitles = new Set();
  let posted = 0;
  let totalFail = 0;

  while (posted < CONFIG.MAX_ARTICLES && totalFail < 5) {
    try {
      console.log(`🤖 記事生成中... (${posted + 1}/${CONFIG.MAX_ARTICLES})`);
      const article = await generateOneArticle(allCandidates, usedUrls, usedTitles);
      if (!article) {
        console.log('⚠️ 記事生成失敗 リトライ...');
        totalFail++;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // 使用済みURLを記録
      if (article.sources && article.sources[0]) usedUrls.add(article.sources[0].url);
      usedTitles.add(article.title);

      await postToFirebase(token, article);
      posted++;
      totalFail = 0;
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      const msg = e.message || '';
      // 429（日次枠超過）は即終了
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded')) {
        console.error(`❌ Gemini無料枠を使い切りました。本日はここまで（${posted}件投稿済み）`);
        break;
      }
      console.error(`❌ 生成/投稿失敗: ${msg}`);
      totalFail++;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`🏁 完了: ${posted}件投稿`);
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
