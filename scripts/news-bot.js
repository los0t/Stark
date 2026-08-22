// scripts/news-bot.js
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

const CONFIG = {
  RSS_FEEDS: [
    {
      url: 'https://feeds.bbci.co.uk/japanese/rss.xml',
      source: 'BBC News Japan'
    }
  ],
  MAX_ARTICLES: 5,
};

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWSBOT_EMAIL = process.env.NEWSBOT_EMAIL;
const NEWSBOT_PASSWORD = process.env.NEWSBOT_PASSWORD;
const NEWSBOT_UID = process.env.NEWSBOT_UID;

async function getFirebaseToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: NEWSBOT_EMAIL,
        password: NEWSBOT_PASSWORD,
        returnSecureToken: true
      })
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('Firebase Auth失敗: ' + JSON.stringify(data));
  console.log('✅ Firebase Auth成功');
  return data.idToken;
}

async function fetchRSS(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'EcstasyNewsBot/1.0' }
  });
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed.rss?.channel;
  if (!channel) throw new Error('RSSのパースに失敗: ' + feedUrl);
  const items = Array.isArray(channel.item) ? channel.item : [channel.item];
  return items.filter(Boolean).map(item => ({
    title: item.title || '',
    url: item.link || item.guid?._ || item.guid || '',
    description: item.description || '',
    pubDate: item.pubDate || '',
    guid: item.guid?._ || item.guid || item.link || ''
  }));
}

async function isAlreadyPosted(guid, token) {
  const key = Buffer.from(guid).toString('base64').replace(/[.#$/[\]]/g, '_');
  const res = await fetch(
    `${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`
  );
  const data = await res.json();
  return data !== null;
}

async function summarizeWithGemini(title, description, url, source) {
  const prompt = `あなたはニュース要約AIです。以下のニュース記事を日本語で簡潔に要約してください。

ルール：
- 3〜5文で要約する
- ニュースの内容を正確に伝える
- 根拠のない推測を追加しない
- 元記事に書かれていない情報を追加しない
- 自然な日本語で書く

記事タイトル: ${title}
記事概要: ${description}
出典: ${source}

要約のみを出力してください。前置きは不要です。`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.3 }
      })
    }
  );
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini要約失敗: ' + JSON.stringify(data));
  return text.trim();
}

async function postToFirebase(token, { title, summary, url, source, guid }) {
  const now = Date.now();
  const displayTitle = `【ニュース】${title}`;
  const postText = `${summary}\n\n📰 引用元：${source}\n${url}`;

  const threadRes = await fetch(
    `${FIREBASE_DB_URL}/threads.json?auth=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: displayTitle.slice(0, 60),
        createdBy: '🤖 AI NEWS',
        createdByUid: NEWSBOT_UID,
        createdByNick: '🤖 AI NEWS',
        createdAt: now,
        lastActivity: now,
        postCount: 1,
        isNewsThread: true
      })
    }
  );
  const threadData = await threadRes.json();
  const tid = threadData.name;
  if (!tid) throw new Error('スレッド作成失敗');

  await fetch(
    `${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: NEWSBOT_UID,
        userId: 'ai_news',
        userNick: '🤖 AI NEWS',
        text: postText,
        ts: now,
        isNewsPost: true,
        newsUrl: url,
        newsSource: source
      })
    }
  );

  const key = Buffer.from(guid).toString('base64').replace(/[.#$/[\]]/g, '_');
  await fetch(
    `${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid, url, postedAt: now, tid })
    }
  );

  console.log(`✅ 投稿完了: ${displayTitle}`);
  return tid;
}

async function main() {
  console.log('🤖 Ecstasy ニュースBot 開始');
  const token = await getFirebaseToken();
  let totalPosted = 0;

  for (const feed of CONFIG.RSS_FEEDS) {
    console.log(`📡 RSS取得: ${feed.url}`);
    let articles;
    try {
      articles = await fetchRSS(feed.url);
      console.log(`  ${articles.length}件取得`);
    } catch (e) {
      console.error(`  RSS取得失敗: ${e.message}`);
      continue;
    }

    for (const article of articles) {
      if (totalPosted >= CONFIG.MAX_ARTICLES) break;
      if (!article.url || !article.title) continue;

      const alreadyPosted = await isAlreadyPosted(article.guid, token);
      if (alreadyPosted) {
        console.log(`  スキップ（重複）: ${article.title.slice(0, 40)}`);
        continue;
      }

      console.log(`  要約中: ${article.title.slice(0, 40)}`);
      let summary;
      try {
        summary = await summarizeWithGemini(
          article.title,
          article.description,
          article.url,
          feed.source
        );
      } catch (e) {
        console.error(`  要約失敗: ${e.message}`);
        summary = article.description.slice(0, 200) || '（要約取得に失敗しました）';
      }

      try {
        await postToFirebase(token, {
          title: article.title,
          summary,
          url: article.url,
          source: feed.source,
          guid: article.guid
        });
        totalPosted++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`  投稿失敗: ${e.message}`);
      }
    }
  }

  console.log(`🏁 完了: ${totalPosted}件投稿`);
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});

