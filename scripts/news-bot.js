// scripts/news-bot.js
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

// ══════════════════════════════════════════════
//  設定
// ══════════════════════════════════════════════
const CONFIG = {
  MODEL: 'gemini-2.5-flash',
  MAX_NEWS_ARTICLES: 24,   // Firebase上に保持する最大記事数
  CANDIDATE_COUNT: 50,     // Geminiに渡す候補数
  RSS_FEEDS: [
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                    source: 'BBC News' },
    { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',   source: 'BBC Entertainment' },
    { url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',      source: 'BBC US & Canada' },
    { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',                 source: 'BBC Business' },
    { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',               source: 'BBC Technology' },
    { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',  source: 'BBC Science' },
    { url: 'https://feeds.bbci.co.uk/news/health/rss.xml',                   source: 'BBC Health' },
    { url: 'https://www.theguardian.com/world/rss',                          source: 'The Guardian' },
    { url: 'https://www.theguardian.com/us-news/rss',                        source: 'The Guardian US' },
    { url: 'https://www.theguardian.com/technology/rss',                     source: 'The Guardian Tech' },
    { url: 'https://www.theguardian.com/culture/rss',                        source: 'The Guardian Culture' },
    { url: 'https://www.aljazeera.com/xml/rss/all.xml',                      source: 'Al Jazeera' },
    { url: 'https://feeds.nbcnews.com/nbcnews/public/news',                  source: 'NBC News' },
    { url: 'https://feeds.abcnews.com/abcnews/topstories',                   source: 'ABC News' },
    { url: 'https://www.euronews.com/rss',                                   source: 'Euronews' },
    { url: 'https://news.google.com/rss/search?q=weird+strange+unusual+news&hl=en-US&gl=US&ceid=US:en',          source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=celebrity+youtuber+influencer&hl=en-US&gl=US&ceid=US:en',      source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=politics+scandal+controversy&hl=en-US&gl=US&ceid=US:en',       source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=viral+social+media&hl=en-US&gl=US&ceid=US:en',                 source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=interesting+world+news&hl=en-US&gl=US&ceid=US:en',             source: 'Google News' },
  ]
};

// ══════════════════════════════════════════════
//  環境変数チェック
// ══════════════════════════════════════════════
const FIREBASE_DB_URL  = process.env.FIREBASE_DB_URL;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const NEWSBOT_EMAIL    = process.env.NEWSBOT_EMAIL;
const NEWSBOT_PASSWORD = process.env.NEWSBOT_PASSWORD;
const NEWSBOT_UID      = process.env.NEWSBOT_UID;

for (const [k, v] of Object.entries({ FIREBASE_DB_URL, FIREBASE_API_KEY, GEMINI_API_KEY, NEWSBOT_EMAIL, NEWSBOT_PASSWORD, NEWSBOT_UID })) {
  if (!v) throw new Error(`環境変数 ${k} が設定されていません`);
}

// ══════════════════════════════════════════════
//  Gemini APIエラー解析
// ══════════════════════════════════════════════
function analyzeGeminiError(status, body) {
  const err   = body?.error;
  const msg   = err?.message || '';
  const code  = err?.code;
  const quota = err?.details?.find(d => d['@type']?.includes('QuotaFailure'))
                  ?.violations?.[0]?.quotaId || '';
  const retryInfo = err?.details?.find(d => d['@type']?.includes('RetryInfo'));
  const retryDelaySec = retryInfo?.retryDelay
    ? parseInt(String(retryInfo.retryDelay).match(/(\d+)/)?.[1] || '30', 10)
    : null;

  console.error(`  [Gemini] status=${status} code=${code}`);
  console.error(`  [Gemini] message=${msg.slice(0, 200)}`);
  console.error(`  [Gemini] quotaId=${quota || '不明'}`);
  if (retryDelaySec !== null) console.error(`  [Gemini] retryDelay=${retryDelaySec}秒`);

  // 404: モデルが存在しない → 即終了
  if (status === 404) {
    console.error('  [判定] モデルが見つからない → 即終了');
    return { type: 'NOT_FOUND', wait: null };
  }
  // 日次クォータ超過 → 即終了
  if (quota.includes('PerDay') || quota.includes('Daily')) {
    console.error('  [判定] 日次クォータ超過 → 即終了');
    return { type: 'DAILY_QUOTA', wait: null };
  }
  // 短時間レート制限 → 待機後リトライ
  if (status === 429) {
    const wait = retryDelaySec ?? 30;
    console.error(`  [判定] レート制限 → ${wait}秒待機`);
    return { type: 'RATE_LIMIT', wait };
  }
  console.error('  [判定] その他エラー');
  return { type: 'OTHER', wait: null };
}

// ══════════════════════════════════════════════
//  Firebase Auth
// ══════════════════════════════════════════════
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
  if (!data.idToken) throw new Error('Firebase Auth失敗: ' + (data.error?.message || ''));
  console.log('✅ Firebase Auth成功');
  return data.idToken;
}

// ══════════════════════════════════════════════
//  既存ニュース記事一覧取得
// ══════════════════════════════════════════════
async function getNewsArticles(token) {
  const res = await fetch(`${FIREBASE_DB_URL}/newsArticles.json?auth=${token}`);
  if (!res.ok) throw new Error(`newsArticles取得失敗: HTTP ${res.status}`);
  const data = await res.json();
  if (!data) return [];
  return Object.entries(data).map(([key, val]) => ({ key, ...val }));
}

// ══════════════════════════════════════════════
//  古いニュース記事を削除（24件を超えた分）
// ══════════════════════════════════════════════
async function trimOldArticles(token) {
  const articles = await getNewsArticles(token);
  if (articles.length <= CONFIG.MAX_NEWS_ARTICLES) {
    console.log(`📊 記事数: ${articles.length}件 → 削除不要`);
    return;
  }

  // postedAt昇順でソート（古い順）
  articles.sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0));
  const deleteCount = articles.length - CONFIG.MAX_NEWS_ARTICLES;
  const toDelete = articles.slice(0, deleteCount);

  for (const article of toDelete) {
    const { key, tid } = article;
    console.log(`🗑️ 古い記事を削除: ${article.title?.slice(0, 40) || key}`);

    // newsArticlesから削除
    await fetch(`${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`, { method: 'DELETE' });

    // スレッドと投稿を削除（tidがある場合のみ・isNewsThreadで確認）
    if (tid) {
      const tRes = await fetch(`${FIREBASE_DB_URL}/threads/${tid}.json?auth=${token}`);
      const tData = await tRes.json();
      if (tData && tData.isNewsThread === true) {
        await fetch(`${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`, { method: 'DELETE' });
        await fetch(`${FIREBASE_DB_URL}/threads/${tid}.json?auth=${token}`, { method: 'DELETE' });
        console.log(`   → スレッド・投稿も削除: ${tid}`);
      } else {
        console.log(`   → スレッド ${tid} はニュース記事ではないためスキップ`);
      }
    }
  }
  console.log(`✅ ${deleteCount}件削除完了 → 残り${CONFIG.MAX_NEWS_ARTICLES}件`);
}

// ══════════════════════════════════════════════
//  RSS取得
// ══════════════════════════════════════════════
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
      const url = typeof item.link === 'string' ? item.link : item.link?._ || '';
      const description = typeof item.description === 'string' ? item.description : item.description?._ || '';
      return { title: item.title || '', url, description: description.slice(0, 150), source: feed.source };
    }).filter(a => a.title && a.url);
  } catch (e) {
    console.error(`❌ ${feed.source} 取得失敗: ${e.message}`);
    return [];
  }
}

// ══════════════════════════════════════════════
//  Geminiで記事を1件生成
// ══════════════════════════════════════════════
async function generateArticle(candidates, existingTitles) {
  // ランダムにCANDIDATE_COUNT件選ぶ
  const sample = candidates.sort(() => Math.random() - 0.5).slice(0, CONFIG.CANDIDATE_COUNT);

  const candidateText = sample.map((a, i) =>
    `[${i + 1}] ${a.source}: ${a.title} | ${a.description}`
  ).join('\n');

  const prompt = `以下のニュース候補から1つ選んで日本語記事を生成してください。

過去に使ったタイトル（重複禁止）:
${existingTitles.slice(-20).join('\n')}

候補:
${candidateText}

以下のJSON形式のみで回答（前置き・コードブロック不要）:
{"title":"タイトル","summary":"200〜400文字の本文","category":"カテゴリ","country":"国名（日本語）","lat":35.7,"lng":139.7,"sourceIndex":1}

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

  const body = await res.json();

  if (!res.ok) {
    const analysis = analyzeGeminiError(res.status, body);
    return { article: null, errorType: analysis.type, wait: analysis.wait };
  }

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('⚠️ Geminiから空のレスポンス');
    return { article: null, errorType: 'EMPTY', wait: null };
  }

  // JSON抽出
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first === -1 || last === -1) {
    console.error('⚠️ JSONが見つからない:', text.slice(0, 100));
    return { article: null, errorType: 'PARSE_ERROR', wait: null };
  }

  let article;
  try {
    article = JSON.parse(text.slice(first, last + 1));
  } catch (e) {
    console.error('⚠️ JSON解析失敗');
    return { article: null, errorType: 'PARSE_ERROR', wait: null };
  }

  if (!article.title || !article.summary || article.lat == null || article.lng == null) {
    console.error('⚠️ 必須フィールド不足:', Object.keys(article));
    return { article: null, errorType: 'INVALID', wait: null };
  }

  // 出典をsourceIndexから取得
  const idx = Math.min(Math.max((article.sourceIndex || 1) - 1, 0), sample.length - 1);
  const chosen = sample[idx];
  article.sources = [{ name: chosen.source, url: chosen.url }];

  return { article, errorType: null, wait: null };
}

// ══════════════════════════════════════════════
//  Firebaseに投稿
// ══════════════════════════════════════════════
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
  if (!threadRes.ok) throw new Error(`スレッド作成失敗: HTTP ${threadRes.status}`);
  const threadData = await threadRes.json();
  const tid = threadData.name;
  if (!tid) throw new Error('スレッドID取得失敗');

  // 投稿作成
  const postRes = await fetch(`${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`, {
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
      newsCategory: article.category || 'ニュース'
    })
  });
  if (!postRes.ok) throw new Error(`投稿作成失敗: HTTP ${postRes.status}`);

  // newsArticlesキャッシュ登録（削除管理用）
  const key = Buffer.from(article.sources[0]?.url || article.title)
    .toString('base64').replace(/[.#$/[\]]/g, '_');
  await fetch(`${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: article.title,
      url: article.sources[0]?.url || '',
      source: article.sources.map(s => s.name).join(', '),
      category: article.category || 'ニュース',
      country: article.country || '',
      lat: article.lat,
      lng: article.lng,
      postedAt: now,
      tid,
      isNewsThread: true
    })
  });

  console.log(`✅ 投稿完了: ${displayTitle} (${article.country} ${article.lat},${article.lng})`);
  return tid;
}

// ══════════════════════════════════════════════
//  メイン（1回の実行で1件だけ生成・投稿）
// ══════════════════════════════════════════════
async function main() {
  console.log('🤖 Ecstasy ニュースBot 開始');
  console.log(`   モデル: ${CONFIG.MODEL}`);

  const token = await getFirebaseToken();

  // 既存記事タイトル取得（重複防止用）
  const existingArticles = await getNewsArticles(token);
  const existingTitles = existingArticles.map(a => a.title).filter(Boolean);
  const existingUrls   = new Set(existingArticles.map(a => a.url).filter(Boolean));
  console.log(`📚 既存記事: ${existingArticles.length}件`);

  // RSS取得
  let allCandidates = [];
  for (const feed of CONFIG.RSS_FEEDS) {
    const articles = await fetchRSS(feed);
    allCandidates = allCandidates.concat(articles);
  }
  // URL重複除去・既存記事を除外
  const uniqueMap = new Map();
  for (const a of allCandidates) {
    if (!uniqueMap.has(a.url) && !existingUrls.has(a.url)) uniqueMap.set(a.url, a);
  }
  allCandidates = Array.from(uniqueMap.values());
  console.log(`📰 候補: ${allCandidates.length}件`);

  if (!allCandidates.length) {
    console.log('⚠️ 候補が0件のため終了');
    return;
  }

  // 記事生成（レート制限時は1回だけリトライ）
  let genResult = await generateArticle(allCandidates, existingTitles);

  if (genResult.errorType === 'NOT_FOUND' || genResult.errorType === 'DAILY_QUOTA') {
    console.error('🛑 致命的エラーのため終了');
    process.exit(1);
  }

  if (genResult.errorType === 'RATE_LIMIT') {
    const wait = genResult.wait ?? 30;
    console.log(`⏳ レート制限 → ${wait}秒待機後リトライ`);
    await new Promise(r => setTimeout(r, wait * 1000));
    genResult = await generateArticle(allCandidates, existingTitles);
    if (!genResult.article) {
      console.error('🛑 リトライも失敗 → 終了');
      process.exit(1);
    }
  }

  if (!genResult.article) {
    console.error(`🛑 記事生成失敗 (${genResult.errorType}) → 終了`);
    process.exit(1);
  }

  // Firebase投稿
  try {
    await postToFirebase(token, genResult.article);
  } catch (e) {
    console.error('❌ Firebase投稿失敗:', e.message);
    process.exit(1);
  }

  // 24件を超えたら古い記事を削除
  await trimOldArticles(token);

  console.log('🏁 完了');
}

main().catch(e => {
  console.error('致命的エラー:', e.message);
  process.exit(1);
});
