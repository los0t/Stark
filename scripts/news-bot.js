// scripts/news-bot.js
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

const CONFIG = {
  // 1回の実行で投稿する記事数
  MAX_ARTICLES: 1,

  // 1記事につき最低2つの出典
  MIN_SOURCES: 2,

  // 使用するGeminiモデル
  MODEL: 'gemini-3.6-flash',

  // Geminiへ送るニュース候補数
  MAX_CANDIDATES: 1000,

  // 1つの出来事について集める関連記事の最大数
  MAX_RELATED_ARTICLES: 50,

  // ニュース候補を集めるRSS
  RSS_FEEDS: [
    {
      url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
      source: 'BBC News'
    },
    {
      url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
      source: 'BBC Entertainment & Arts'
    },
    {
      url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
      source: 'BBC US & Canada'
    },

    {
      url: 'https://news.google.com/rss/search?q=weird+strange+incident+OR+unusual+news&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },
    {
      url: 'https://news.google.com/rss/search?q=celebrity+OR+youtuber+OR+influencer+news&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },
    {
      url: 'https://news.google.com/rss/search?q=politics+OR+scandal+OR+controversy&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },
    {
      url: 'https://news.google.com/rss/search?q=viral+internet+news+OR+social+media+controversy&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    }
  ]
};

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWSBOT_EMAIL = process.env.NEWSBOT_EMAIL;
const NEWSBOT_PASSWORD = process.env.NEWSBOT_PASSWORD;
const NEWSBOT_UID = process.env.NEWSBOT_UID;


/* =========================================================
   環境変数チェック
========================================================= */

if (
  !FIREBASE_DB_URL ||
  !FIREBASE_API_KEY ||
  !GEMINI_API_KEY ||
  !NEWSBOT_EMAIL ||
  !NEWSBOT_PASSWORD ||
  !NEWSBOT_UID
) {
  throw new Error('必要な環境変数が設定されていません');
}


/* =========================================================
   Firebase Authentication
========================================================= */

async function getFirebaseToken() {

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        email: NEWSBOT_EMAIL,
        password: NEWSBOT_PASSWORD,
        returnSecureToken: true
      })
    }
  );

  const data = await res.json();

  if (!data.idToken) {

    throw new Error(
      'Firebase Auth失敗: ' +
      JSON.stringify(data)
    );
  }

  console.log('✅ Firebase Auth成功');

  return data.idToken;
}


/* =========================================================
   RSS取得
========================================================= */

async function fetchRSS(feed) {

  try {

    console.log(
      `📡 RSS取得: ${feed.source}`
    );

    const res = await fetch(
      feed.url,
      {
        headers: {
          'User-Agent':
            'EcstasyNewsBot/1.0'
        }
      }
    );

    if (!res.ok) {

      throw new Error(
        `HTTP ${res.status}`
      );
    }

    const xml =
      await res.text();

    const parsed =
      await parseStringPromise(
        xml,
        {
          explicitArray: false
        }
      );

    const channel =
      parsed.rss?.channel;

    if (!channel) {

      throw new Error(
        'RSSのパースに失敗'
      );
    }

    const rawItems =
      channel.item;

    const items =
      Array.isArray(rawItems)
        ? rawItems
        : rawItems
          ? [rawItems]
          : [];

    return items
      .map(item => {

        let url = '';

        if (
          typeof item.link ===
          'string'
        ) {

          url =
            item.link;

        } else if (
          item.link?._
        ) {

          url =
            item.link._;
        }


        let description = '';

        if (
          typeof item.description ===
          'string'
        ) {

          description =
            item.description;

        } else if (
          item.description?._
        ) {

          description =
            item.description._;
        }


        let pubDate = '';

        if (
          typeof item.pubDate ===
          'string'
        ) {

          pubDate =
            item.pubDate;
        }


        return {
          title:
            item.title || '',

          url,

          description,

          pubDate,

          source:
            feed.source
        };

      })
      .filter(
        item =>
          item.title &&
          item.url
      );

  } catch (error) {

    console.error(
      `❌ ${feed.source} 取得失敗: ${error.message}`
    );

    return [];
  }
}


/* =========================================================
   Firebaseから過去記事取得
========================================================= */

async function getExistingArticles(token) {

  const res = await fetch(
    `${FIREBASE_DB_URL}/newsArticles.json?auth=${token}`
  );

  if (!res.ok) {

    throw new Error(
      `既存記事取得失敗: HTTP ${res.status}`
    );
  }

  const data =
    await res.json();

  if (!data) {
    return [];
  }

  return Object.values(data);
}


/* =========================================================
   Gemini API
========================================================= */

async function callGemini(prompt) {

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json'
      },

      body: JSON.stringify({

        contents: [
          {
            parts: [
              {
                text:
                  prompt
              }
            ]
          }
        ],

        generationConfig: {

          temperature:
            0.4,

          maxOutputTokens:
            7000,

          responseMimeType:
            'application/json'
        }
      })
    }
  );

  const data =
    await res.json();

  if (!res.ok) {

    throw new Error(
      'Gemini API失敗: ' +
      JSON.stringify(data)
    );
  }

  const text =
    data.candidates
      ?.[
        0
      ]
      ?.content
      ?.parts
      ?.[
        0
      ]
      ?.text;

  if (!text) {

    throw new Error(
      'Geminiから回答が返されませんでした: ' +
      JSON.stringify(data)
    );
  }

  let cleaned =
    text.trim();

  cleaned =
    cleaned
      .replace(
        /^```json\s*/i,
        ''
      )
      .replace(
        /^```\s*/i,
        ''
      )
      .replace(
        /\s*```$/i,
        ''
      )
      .trim();


  const firstBrace =
    cleaned.indexOf('{');

  const lastBrace =
    cleaned.lastIndexOf('}');

  if (
    firstBrace !== -1 &&
    lastBrace !== -1 &&
    lastBrace > firstBrace
  ) {

    cleaned =
      cleaned.slice(
        firstBrace,
        lastBrace + 1
      );
  }


  try {

    return JSON.parse(
      cleaned
    );

  } catch (error) {

    console.error(
      'Geminiの返答:',
      text
    );

    throw new Error(
      'GeminiのJSON解析に失敗しました'
    );
  }
}


/* =========================================================
   ① 1000件から最も興味深い出来事を1つ選ぶ
========================================================= */

async function selectInterestingEvent(
  candidates,
  existingArticles
) {

  const previousTitles =
    existingArticles
      .map(
        article =>
          article.title
      )
      .filter(Boolean)
      .slice(-100);


  /*
   * 1000件全部を候補として渡す。
   *
   * 記事本文全体ではなく、
   * タイトル・媒体・日時・概要を使用。
   */

  const candidateText =
    candidates
      .map(
        (article, index) => {

          return `
[候補 ${index + 1}]
媒体: ${article.source}
タイトル: ${article.title}
公開日時: ${article.pubDate}
概要: ${article.description}
`;
        }
      )
      .join('\n');


  const prompt = `
あなたは「Ecstasy」という日本語SNSのニュース編集AIです。

以下には海外ニュースRSSから集めた最大1000件のニュース候補があります。

この1000件をすべて確認し、
「日本の若者が最も興味を持ちそうな1つの出来事」
を選んでください。

重要なのは「記事」ではなく「出来事」を1つ選ぶことです。

例えば、

BBCの記事
CNNの記事
Fox Newsの記事
Guardianの記事

が同じ事件について報じている場合、
それらは別々のニュースではなく、
「1つの出来事」として扱います。

==================================================
【選定基準】
==================================================

以下を特に重視してください。

・何それ！？と思わせる
・意外性がある
・珍しい
・話題性が高い
・SNSで議論されそう
・日本人が知らなそう
・海外で実際に起きた出来事
・複数媒体から報道されている可能性がある
・記事として詳しく紹介する価値がある

ただし、

・架空の事件は禁止
・噂だけの話は禁止
・単なる広告は禁止
・同じ内容の古い記事より新しい出来事を優先
・既に投稿したニュースは避ける

==================================================
【過去記事】
==================================================

${previousTitles.join('\n')}

==================================================
【ニュース候補1000件】
==================================================

${candidateText}

==================================================
【出力】
==================================================

必ずJSONのみ。

{
  "selectedIndex": 123,
  "event": "選択した出来事を短く説明",
  "reason": "この出来事を選んだ理由"
}
`;


  const result =
    await callGemini(
      prompt
    );


  const index =
    Number(
      result.selectedIndex
    );


  if (
    !Number.isInteger(index) ||
    index < 1 ||
    index > candidates.length
  ) {

    throw new Error(
      `Geminiが不正な候補番号を返しました: ${result.selectedIndex}`
    );
  }


  const selected =
    candidates[index - 1];


  console.log(
    `🎯 選択された出来事: ${result.event}`
  );

  console.log(
    `💡 選択理由: ${result.reason}`
  );

  console.log(
    `📰 基準記事: ${selected.title}`
  );


  return {
    event:
      result.event,

    selectedArticle:
      selected
  };
}


/* =========================================================
   ② 1000件から同じ出来事の記事をすべて抽出
========================================================= */

async function findRelatedArticles(
  candidates,
  selectedEvent,
  selectedArticle
) {

  const candidateText =
    candidates
      .map(
        (article, index) => {

          return `
[候補 ${index + 1}]
媒体: ${article.source}
タイトル: ${article.title}
公開日時: ${article.pubDate}
URL: ${article.url}
概要: ${article.description}
`;
        }
      )
      .join('\n');


  const prompt = `
あなたはニュース調査AIです。

まず、今回調査する出来事は以下です。

==================================================
【選択された出来事】
==================================================

${selectedEvent}

基準記事:
媒体: ${selectedArticle.source}
タイトル: ${selectedArticle.title}
URL: ${selectedArticle.url}
概要:
${selectedArticle.description}

==================================================
【目的】
==================================================

以下の1000件のニュース候補の中から、

「上記の出来事と同じ事件・事故・ニュース・騒動を報じている記事」

をすべて探してください。

非常に重要です。

単に似た単語が入っているだけの記事は除外してください。

例えば、

「富士山で7歳児を置き去りにした父親」

が対象なら、

・同じ父親についての記事
・同じ7歳児についての記事
・同じ事件についての記事
・同じ事件を別のニュース会社が報じた記事

は含めます。

一方、

・別の富士山ニュース
・別の子供置き去り事件
・単に「富士山」という単語が入っている記事

は除外してください。

==================================================
【重要】
==================================================

1000件を確認してください。

同じ出来事を報じている記事は、
媒体が違ってもすべて抽出してください。

最大${CONFIG.MAX_RELATED_ARTICLES}件まで返してください。

==================================================
【1000件の候補】
==================================================

${candidateText}

==================================================
【出力】
==================================================

必ずJSONのみ。

{
  "relatedIndexes": [12, 45, 78],
  "reason": "関連記事と判断した理由"
}

relatedIndexesには、
同じ出来事を扱っている候補番号をすべて入れてください。

`;


  const result =
    await callGemini(
      prompt
    );


  if (
    !Array.isArray(
      result.relatedIndexes
    )
  ) {

    throw new Error(
      '関連記事番号が配列ではありません'
    );
  }


  const indexes =
    result.relatedIndexes
      .map(
        index =>
          Number(index)
      )
      .filter(
        index =>
          Number.isInteger(index) &&
          index >= 1 &&
          index <= candidates.length
      );


  const uniqueIndexes =
    [...new Set(indexes)]
      .slice(
        0,
        CONFIG.MAX_RELATED_ARTICLES
      );


  const relatedArticles =
    uniqueIndexes.map(
      index =>
        candidates[index - 1]
    );


  /*
   * 基準記事が漏れていた場合は追加
   */

  if (
    !relatedArticles.some(
      article =>
        article.url ===
        selectedArticle.url
    )
  ) {

    relatedArticles.unshift(
      selectedArticle
    );
  }


  console.log(
    `🔎 同じ出来事の記事を ${relatedArticles.length}件発見`
  );

  console.log(
    `💡 ${result.reason || ''}`
  );


  for (
    const article
    of relatedArticles
  ) {

    console.log(
      `   📰 ${article.source}: ${article.title}`
    );
  }


  return relatedArticles
    .slice(
      0,
      CONFIG.MAX_RELATED_ARTICLES
    );
}


/* =========================================================
   ③ 関連記事をすべて比較して1記事にまとめる
========================================================= */

async function generateFinalArticle(
  relatedArticles,
  selectedEvent,
  existingArticles
) {

  const previousTitles =
    existingArticles
      .map(
        article =>
          article.title
      )
      .filter(Boolean)
      .slice(-100);


  const relatedText =
    relatedArticles
      .map(
        (article, index) => {

          return `
==================================================
【関連記事 ${index + 1}】

媒体:
${article.source}

タイトル:
${article.title}

公開日時:
${article.pubDate}

URL:
${article.url}

概要:
${article.description}
`;
        }
      )
      .join('\n');


  const prompt = `
あなたは「Ecstasy」という日本語SNSのニュース編集AIです。

複数の海外ニュース媒体が報じた
「1つの同じ出来事」について、
それぞれの記事を比較・照合し、
Ecstasy用のニュース記事を1本作成してください。

==================================================
【今回の出来事】
==================================================

${selectedEvent}

==================================================
【関連記事】
==================================================

以下は、この出来事を報じていると判断された記事です。

${relatedText}

==================================================
【情報の扱い】
==================================================

非常に重要です。

複数の記事を比較してください。

複数媒体で共通して確認できる情報を優先してください。

媒体によって内容が違う場合は、
無理に一つに決めつけないでください。

「BBCによると」
「別の報道では」
など、必要に応じて情報源の違いを説明してください。

架空の情報を追加してはいけません。

記事に存在しない情報を推測で追加してはいけません。

「逮捕」
「死亡」
「犯罪」
「性的スキャンダル」
など重大な情報については特に慎重にしてください。

元記事の文章をそのままコピーしないでください。

必ず自分の言葉で要約してください。

==================================================
【記事の内容】
==================================================

1記事400〜700文字程度。

以下を自然なニュース記事として説明してください。

・何が起きたのか
・いつ起きたのか
・どこで起きたのか
・誰が関係しているのか
・なぜ話題になったのか
・現在どうなっているのか
・必要なら背景

単なる箇条書きは禁止です。

==================================================
【見出し】
==================================================

SNSで目を引く見出しにしてください。

例：

【まさかの展開】○○をめぐり海外で思わぬ騒動に

【実は○○だった！？】知られざる○○の事実

【なぜこうなった？】○○をめぐって大きな話題に

ただし、

・嘘をつかない
・事実を歪めない
・過度に煽らない

こと。

==================================================
【出典】
==================================================

実際に今回渡された関連記事のURLだけを使用してください。

最低${CONFIG.MIN_SOURCES}つの異なる出典を付けてください。

可能なら異なるニュース媒体を使用してください。

架空URLは禁止です。

==================================================
【過去記事】
==================================================

以下と同じニュースは避けてください。

${previousTitles.join('\n')}

==================================================
【category】
==================================================

以下から1つ選択してください。

海外事件
海外ニュース
政治・社会
芸能
YouTuber・インフルエンサー
スキャンダル
雑学
その他

==================================================
【出力】
==================================================

JSONのみ。

{
  "articles": [
    {
      "title": "記事の見出し",
      "summary": "400〜700文字程度の記事本文",
      "category": "海外事件",
      "sources": [
        {
          "name": "媒体名",
          "url": "関連記事に存在するURL"
        },
        {
          "name": "媒体名",
          "url": "関連記事に存在するURL"
        }
      ]
    }
  ]
}
`;


  const result =
    await callGemini(
      prompt
    );


  if (
    !Array.isArray(
      result.articles
    )
  ) {

    throw new Error(
      'Geminiのarticlesが配列ではありません'
    );
  }


  return result.articles
    .filter(
      article =>
        article &&
        article.title &&
        article.summary &&
        Array.isArray(
          article.sources
        )
    )
    .slice(
      0,
      CONFIG.MAX_ARTICLES
    );
}


/* =========================================================
   出典URLの検証
========================================================= */

function validateSources(
  article,
  candidates
) {

  const candidateUrls =
    new Set(
      candidates.map(
        item =>
          item.url
      )
    );


  const validSources =
    [];


  for (
    const source
    of article.sources
  ) {

    if (
      !source ||
      !source.name ||
      !source.url
    ) {

      continue;
    }


    /*
     * Geminiが勝手にURLを作っていないか確認
     */

    if (
      !candidateUrls.has(
        source.url
      )
    ) {

      console.log(
        `⚠️ 候補に存在しないURLを除外: ${source.url}`
      );

      continue;
    }


    /*
     * URL重複防止
     */

    if (
      !validSources.some(
        item =>
          item.url ===
          source.url
      )
    ) {

      validSources.push({

        name:
          source.name,

        url:
          source.url
      });
    }
  }


  return validSources;
}


/* =========================================================
   Firebaseへニュース投稿
========================================================= */

async function postToFirebase(
  token,
  article
) {

  const now =
    Date.now();


  const displayTitle =
    `【${article.category || 'ニュース'}】${article.title}`;


  let postText =
    `${article.summary}\n\n` +
    `📰 出典\n`;


  for (
    const source
    of article.sources
  ) {

    postText +=
      `・${source.name}\n` +
      `${source.url}\n`;
  }


  /* =======================================================
     スレッド作成
  ======================================================= */

  const threadRes =
    await fetch(
      `${FIREBASE_DB_URL}/threads.json?auth=${token}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            title:
              displayTitle.slice(
                0,
                100
              ),

            createdBy:
              '🤖 AI NEWS',

            createdByUid:
              NEWSBOT_UID,

            createdByNick:
              '🤖 AI NEWS',

            createdAt:
              now,

            lastActivity:
              now,

            postCount:
              1,

            isNewsThread:
              true,

            newsCategory:
              article.category ||
              'ニュース'
          })
      }
    );


  const threadData =
    await threadRes.json();


  const tid =
    threadData.name;


  if (!tid) {

    throw new Error(
      'スレッド作成失敗: ' +
      JSON.stringify(
        threadData
      )
    );
  }


  /* =======================================================
     本文投稿
  ======================================================= */

  const postRes =
    await fetch(
      `${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            uid:
              NEWSBOT_UID,

            userId:
              'ai_news',

            userNick:
              '🤖 AI NEWS',

            text:
              postText,

            ts:
              now,

            isNewsPost:
              true,

            newsUrl:
              article.sources[0]
                ?.url ||
              '',

            newsSource:
              article.sources
                .map(
                  source =>
                    source.name
                )
                .join(', '),

            newsSources:
              article.sources,

            newsCategory:
              article.category ||
              'ニュース'
          })
      }
    );


  if (!postRes.ok) {

    throw new Error(
      `ニュース本文投稿失敗: HTTP ${postRes.status}`
    );
  }


  /* =======================================================
     投稿済みニュース保存
  ======================================================= */

  const sourceKey =
    article.sources
      .map(
        source =>
          source.url
      )
      .sort()
      .join('|');


  const key =
    Buffer
      .from(sourceKey)
      .toString('base64')
      .replace(
        /[.#$/[\]]/g,
        '_'
      );


  const saveRes =
    await fetch(
      `${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`,
      {
        method: 'PUT',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            title:
              article.title,

            url:
              article.sources[0]
                ?.url ||
              '',

            source:
              article.sources
                .map(
                  source =>
                    source.name
                )
                .join(', '),

            sources:
              article.sources,

            category:
              article.category ||
              'ニュース',

            postedAt:
              now,

            tid
          })
      }
    );


  if (!saveRes.ok) {

    throw new Error(
      `ニュース履歴保存失敗: HTTP ${saveRes.status}`
    );
  }


  console.log(
    `✅ 投稿完了: ${displayTitle}`
  );

  console.log(
    `   出典数: ${article.sources.length}`
  );


  return tid;
}


/* =========================================================
   メイン処理
========================================================= */

async function main() {

  console.log(
    '🤖 Ecstasy ニュースBot 開始'
  );


  /* =======================================================
     Firebaseログイン
  ======================================================= */

  const token =
    await getFirebaseToken();


  /* =======================================================
     過去記事取得
  ======================================================= */

  const existingArticles =
    await getExistingArticles(
      token
    );


  console.log(
    `📚 既存記事: ${existingArticles.length}件`
  );


  /* =======================================================
     RSS取得
  ======================================================= */

  let allCandidates =
    [];


  for (
    const feed
    of CONFIG.RSS_FEEDS
  ) {

    const articles =
      await fetchRSS(
        feed
      );


    console.log(
      `   ${articles.length}件取得`
    );


    allCandidates =
      allCandidates.concat(
        articles
      );
  }


  console.log(
    `📰 合計 ${allCandidates.length}件の候補を取得`
  );


  /* =======================================================
     URL重複削除
  ======================================================= */

  const uniqueMap =
    new Map();


  for (
    const article
    of allCandidates
  ) {

    if (
      !uniqueMap.has(
        article.url
      )
    ) {

      uniqueMap.set(
        article.url,
        article
      );
    }
  }


  allCandidates =
    Array.from(
      uniqueMap.values()
    );


  console.log(
    `🧹 URL重複削除後: ${allCandidates.length}件`
  );


  /* =======================================================
     最大1000件
  ======================================================= */

  allCandidates =
    allCandidates.slice(
      0,
      CONFIG.MAX_CANDIDATES
    );


  console.log(
    `📚 Gemini対象候補: ${allCandidates.length}件`
  );


  if (
    allCandidates.length ===
    0
  ) {

    console.log(
      '⚠️ ニュース候補がありません'
    );

    return;
  }


  /* =======================================================
     ① 1000件から1つの出来事を選択
  ======================================================= */

  console.log(
    '🤖 1000件から最も興味深い出来事を選択中...'
  );


  let selected;


  try {

    selected =
      await selectInterestingEvent(
        allCandidates,
        existingArticles
      );

  } catch (error) {

    console.error(
      `❌ 出来事選択失敗: ${error.message}`
    );

    throw error;
  }


  /* =======================================================
     ② 1000件から同じ出来事の記事を抽出
  ======================================================= */

  console.log(
    '🔎 1000件の中から同じ出来事を報じている記事を検索中...'
  );


  let relatedArticles;


  try {

    relatedArticles =
      await findRelatedArticles(
        allCandidates,
        selected.event,
        selected.selectedArticle
      );

  } catch (error) {

    console.error(
      `❌ 関連記事抽出失敗: ${error.message}`
    );

    throw error;
  }


  if (
    relatedArticles.length <
    CONFIG.MIN_SOURCES
  ) {

    throw new Error(
      `関連記事が${CONFIG.MIN_SOURCES}件未満でした`
    );
  }


  /* =======================================================
     ③ 関連記事をまとめて1記事にする
  ======================================================= */

  console.log(
    `📝 ${relatedArticles.length}件の関連記事を比較して1記事にまとめています...`
  );


  let articles;


  try {

    articles =
      await generateFinalArticle(
        relatedArticles,
        selected.event,
        existingArticles
      );

  } catch (error) {

    console.error(
      `❌ 記事生成失敗: ${error.message}`
    );

    throw error;
  }


  console.log(
    `🤖 最終記事: ${articles.length}件`
  );


  /* =======================================================
     Firebaseへ投稿
  ======================================================= */

  let posted =
    0;


  for (
    const article
    of articles
  ) {

    try {

      /*
       * 関連記事のURLだけを
       * 正しい出典として許可
       */

      const validSources =
        validateSources(
          article,
          relatedArticles
        );


      if (
        validSources.length <
        CONFIG.MIN_SOURCES
      ) {

        console.log(
          `⚠️ 出典不足のため投稿スキップ: ${article.title}`
        );

        console.log(
          `   出典数: ${validSources.length}`
        );

        continue;
      }


      article.sources =
        validSources;


      /* ===================================================
         過去記事との重複確認
      =================================================== */

      const existingUrls =
        new Set(
          existingArticles
            .map(
              item =>
                item.url
            )
            .filter(Boolean)
        );


      const alreadyPosted =
        article.sources.some(
          source =>
            existingUrls.has(
              source.url
            )
        );


      if (
        alreadyPosted
      ) {

        console.log(
          `⏭️ 既存ニュースと重複: ${article.title}`
        );

        continue;
      }


      /* ===================================================
         投稿
      =================================================== */

      await postToFirebase(
        token,
        article
      );


      posted++;


      /*
       * 連続投稿間隔
       */

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            3000
          )
      );

    } catch (error) {

      console.error(
        `❌ 投稿失敗: ${error.message}`
      );
    }
  }


  console.log(
    `🏁 完了: ${posted}件投稿`
  );
}


/* =========================================================
   実行
========================================================= */

main()
  .catch(
    error => {

      console.error(
        '致命的エラー:',
        error
      );

      process.exit(
        1
      );
    }
  );