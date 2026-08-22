// scripts/news-bot.js

import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';


const CONFIG = {

  // 1回の実行で投稿する記事数
  MAX_ARTICLES: 1,

  // 関連記事は1件でもOK
  MIN_RELATED_ARTICLES: 1,

  // 最大候補数
  MAX_CANDIDATES: 1000,

  // Geminiモデル
  MODEL: 'gemini-3.6-flash',

  // Gemini API最大リトライ
  MAX_RETRIES: 2,

  // ニュースRSS
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
      url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
      source: 'BBC Business'
    },

    {
      url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
      source: 'BBC Technology'
    },

    {
      url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
      source: 'BBC Science & Environment'
    },

    {
      url: 'https://feeds.bbci.co.uk/news/health/rss.xml',
      source: 'BBC Health'
    },

    {
      url: 'https://feeds.reuters.com/reuters/topNews',
      source: 'Reuters'
    },

    {
      url: 'https://feeds.reuters.com/reuters/worldNews',
      source: 'Reuters World'
    },

    {
      url: 'https://feeds.reuters.com/reuters/entertainment',
      source: 'Reuters Entertainment'
    },

    {
      url: 'https://feeds.reuters.com/reuters/businessNews',
      source: 'Reuters Business'
    },

    {
      url: 'https://feeds.reuters.com/reuters/technologyNews',
      source: 'Reuters Technology'
    },

    {
      url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
      source: 'The New York Times'
    },

    {
      url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
      source: 'The New York Times Business'
    },

    {
      url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
      source: 'The New York Times Technology'
    },

    {
      url: 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml',
      source: 'The New York Times Arts'
    },

    {
      url: 'https://www.theguardian.com/world/rss',
      source: 'The Guardian'
    },

    {
      url: 'https://www.theguardian.com/us-news/rss',
      source: 'The Guardian US'
    },

    {
      url: 'https://www.theguardian.com/technology/rss',
      source: 'The Guardian Technology'
    },

    {
      url: 'https://www.theguardian.com/culture/rss',
      source: 'The Guardian Culture'
    },

    {
      url: 'https://rss.cnn.com/rss/edition_world.rss',
      source: 'CNN World'
    },

    {
      url: 'https://rss.cnn.com/rss/edition_us.rss',
      source: 'CNN US'
    },

    {
      url: 'https://rss.cnn.com/rss/edition_entertainment.rss',
      source: 'CNN Entertainment'
    },

    {
      url: 'https://rss.cnn.com/rss/edition_technology.rss',
      source: 'CNN Technology'
    },

    {
      url: 'https://feeds.nbcnews.com/nbcnews/public/news',
      source: 'NBC News'
    },

    {
      url: 'https://feeds.nbcnews.com/nbcnews/public/world',
      source: 'NBC News World'
    },

    {
      url: 'https://feeds.nbcnews.com/nbcnews/public/entertainment',
      source: 'NBC News Entertainment'
    },

    {
      url: 'https://feeds.nbcnews.com/nbcnews/public/technology',
      source: 'NBC News Technology'
    },

    {
      url: 'https://abcnews.go.com/abcnews/topstories',
      source: 'ABC News'
    },

    {
      url: 'https://abcnews.go.com/abcnews/international',
      source: 'ABC News International'
    },

    {
      url: 'https://abcnews.go.com/abcnews/entertainment',
      source: 'ABC News Entertainment'
    },

    {
      url: 'https://www.aljazeera.com/xml/rss/all.xml',
      source: 'Al Jazeera'
    },

    {
      url: 'https://www.euronews.com/rss',
      source: 'Euronews'
    },

    {
      url: 'https://www.independent.co.uk/news/world/rss',
      source: 'The Independent'
    },

    {
      url: 'https://www.independent.co.uk/arts-entertainment/rss',
      source: 'The Independent Entertainment'
    },

    {
      url: 'https://news.google.com/rss/search?q=weird+strange+incident+OR+unusual+news&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },

    {
      url: 'https://news.google.com/rss/search?q=viral+news+OR+internet+controversy&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },

    {
      url: 'https://news.google.com/rss/search?q=celebrity+OR+youtuber+OR+influencer&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },

    {
      url: 'https://news.google.com/rss/search?q=unusual+law+OR+strange+law&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },

    {
      url: 'https://news.google.com/rss/search?q=scandal+OR+controversy+OR+backlash&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },

    {
      url: 'https://news.google.com/rss/search?q=funny+news+OR+weird+news&hl=en-US&gl=US&ceid=US:en',
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


if (
  !FIREBASE_DB_URL ||
  !FIREBASE_API_KEY ||
  !GEMINI_API_KEY ||
  !NEWSBOT_EMAIL ||
  !NEWSBOT_PASSWORD ||
  !NEWSBOT_UID
) {

  throw new Error(
    '必要な環境変数が設定されていません'
  );

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


  if (
    !res.ok ||
    !data.idToken
  ) {

    throw new Error(
      'Firebase Auth失敗: ' +
      JSON.stringify(data)
    );

  }


  console.log(
    '✅ Firebase Auth成功'
  );


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
      parsed.rss?.channel ||
      parsed.feed;


    if (!channel) {

      throw new Error(
        'RSSのパースに失敗'
      );

    }


    const rawItems =
      channel.item ||
      channel.entry;


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

        } else if (
          Array.isArray(item.link)
        ) {

          const link =
            item.link.find(
              x =>
                x?.$?.rel ===
                'alternate'
            ) ||
            item.link[0];

          url =
            link?.$?.href ||
            link?._ ||
            '';

        } else if (
          item.link?.$?.href
        ) {

          url =
            item.link.$.href;

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

        } else if (
          typeof item.summary ===
          'string'
        ) {

          description =
            item.summary;

        } else if (
          item.summary?._
        ) {

          description =
            item.summary._;

        }


        let pubDate = '';


        if (
          typeof item.pubDate ===
          'string'
        ) {

          pubDate =
            item.pubDate;

        } else if (
          typeof item.published ===
          'string'
        ) {

          pubDate =
            item.published;

        } else if (
          item.published?._
        ) {

          pubDate =
            item.published._;

        }


        return {

          title:
            typeof item.title ===
            'string'
              ? item.title
              : item.title?._ || '',

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
   Firebase過去記事
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
   sleep
========================================================= */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );

}


/* =========================================================
   Gemini API
========================================================= */

async function callGemini(
  prompt
) {

  let lastError =
    null;


  for (
    let attempt = 1;
    attempt <= CONFIG.MAX_RETRIES;
    attempt++
  ) {

    try {

      console.log(
        `🤖 Gemini API実行 (${attempt}/${CONFIG.MAX_RETRIES})`
      );


      const res =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({

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


      if (res.ok) {

        return data;

      }


      lastError =
        new Error(
          'Gemini API失敗: ' +
          JSON.stringify(data)
        );


      if (
        res.status === 429
      ) {

        console.warn(
          '⚠️ Gemini 429: クォータ/レート制限です'
        );

        /*
         * 429を何度も叩かない
         */

        throw lastError;

      }


      if (
        res.status >= 500 &&
        attempt < CONFIG.MAX_RETRIES
      ) {

        await sleep(
          3000 * attempt
        );

        continue;

      }


      throw lastError;


    } catch (error) {

      if (
        error.message?.includes(
          'Gemini API失敗'
        )
      ) {

        throw error;

      }


      lastError =
        error;


      if (
        attempt <
        CONFIG.MAX_RETRIES
      ) {

        await sleep(
          3000 * attempt
        );

      }

    }

  }


  throw (
    lastError ||
    new Error(
      'Gemini APIに接続できませんでした'
    )
  );

}


/* =========================================================
   JSON解析
========================================================= */

function parseGeminiJson(
  text
) {

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


  return JSON.parse(
    cleaned
  );

}


/* =========================================================
   Gemini候補選択
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


  const candidateText =
    candidates
      .map(
        (article, index) => {

          return `
---候補 ${index + 1}---

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

以下に最大1000件のニュース候補があります。

この中から、
日本の若者が最も「何それ？」「詳しく知りたい」と思いそうな
非常に興味深い「1つの出来事」を選んでください。

重要なのは「記事」を選ぶことではなく、
「1つの出来事」を選ぶことです。

例えば、

A社「ある珍事件が発生」
B社「同じ珍事件を報道」
C社「同じ珍事件を報道」

という候補があれば、
3つの記事を別々に選ぶのではなく、

「その珍事件」

という1つの出来事を選択してください。


【優先するニュース】

・珍事件
・意外な事件
・海外のおもしろニュース
・日本人が知らない海外事情
・意外な法律や制度
・芸能
・YouTuber
・インフルエンサー
・SNSで話題の出来事
・スキャンダル
・政治・社会
・変わった文化
・思わず人に話したくなるニュース


【禁止】

・候補にない情報を作らない
・存在しないニュースを作らない
・過去記事と同じ出来事を選ばない


【過去記事】

${previousTitles.join('\n')}


【ニュース候補】

${candidateText}


【出力】

必ずJSONのみ。

{
  "event": {
    "title": "選択した出来事を短く表現",
    "reason": "なぜこの出来事を選んだのか",
    "candidateIndex": 1
  }
}

candidateIndexは、
この候補一覧における基準記事の番号です。

`;


  const data =
    await callGemini(
      prompt
    );


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
      'Geminiから選択結果が返されませんでした'
    );

  }


  const result =
    parseGeminiJson(
      text
    );


  if (
    !result.event ||
    !result.event.candidateIndex
  ) {

    throw new Error(
      'Geminiの出来事選択結果が不正です'
    );

  }


  const index =
    Number(
      result.event.candidateIndex
    ) - 1;


  if (
    index < 0 ||
    index >= candidates.length
  ) {

    throw new Error(
      'Geminiが不正な候補番号を返しました'
    );

  }


  return {

    event:
      result.event,

    baseArticle:
      candidates[index]

  };

}


/* =========================================================
   関連記事検索
========================================================= */

async function findRelatedArticles(
  candidates,
  selectedEvent,
  baseArticle
) {

  const candidateText =
    candidates
      .map(
        (article, index) => {

          return `
---候補 ${index + 1}---

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

あなたはニュース記事の調査AIです。

以下の「選択された出来事」と、
最大1000件のニュース候補があります。

選択された出来事と「同じ出来事」を報じている候補記事を
できるだけすべて探してください。

重要：

・似たジャンルの記事ではなく、同じ出来事を探す
・別の事件を混ぜない
・同じ人物でも別事件なら除外
・同じ場所でも別事件なら除外
・タイトルだけでなく概要も比較する
・明らかに同じ出来事なら採用
・1件しかなくても問題ない
・基準記事そのものも関連記事として採用する


【選択された出来事】

${selectedEvent.title}

選択理由:

${selectedEvent.reason}


【基準記事】

媒体:
${baseArticle.source}

タイトル:
${baseArticle.title}

URL:
${baseArticle.url}

概要:
${baseArticle.description}


【候補一覧】

${candidateText}


【出力】

必ずJSONのみ。

{
  "relatedArticles": [
    {
      "candidateIndex": 1,
      "reason": "同じ出来事だと判断した理由"
    }
  ]
}

`;



  const data =
    await callGemini(
      prompt
    );


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
      '関連記事検索結果が返されませんでした'
    );

  }


  const result =
    parseGeminiJson(
      text
    );


  if (
    !Array.isArray(
      result.relatedArticles
    )
  ) {

    throw new Error(
      'relatedArticlesが配列ではありません'
    );

  }


  const related =
    [];


  for (
    const item
    of result.relatedArticles
  ) {

    const index =
      Number(
        item.candidateIndex
      ) - 1;


    if (
      index < 0 ||
      index >= candidates.length
    ) {

      continue;

    }


    const article =
      candidates[index];


    if (
      !related.some(
        x =>
          x.url ===
          article.url
      )
    ) {

      related.push(
        article
      );

    }

  }


  /*
   * 基準記事が漏れていた場合は追加
   */

  if (
    !related.some(
      x =>
        x.url ===
        baseArticle.url
    )
  ) {

    related.unshift(
      baseArticle
    );

  }


  return related;

}


/* =========================================================
   関連記事から1記事生成
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


  const sourceText =
    relatedArticles
      .map(
        (article, index) => {

          return `
---関連記事 ${index + 1}---

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

今回選ばれた「1つの出来事」について、
関連するニュース記事をまとめ、
Ecstasy向けの「1つの記事」を作成してください。

記事を複数作ってはいけません。

必ず1つの記事にまとめてください。


【選択された出来事】

${selectedEvent.title}


【関連記事】

${sourceText}


【最重要】

関連記事が1件しかない場合でも記事を作成してください。

関連記事が複数ある場合は、
複数の報道内容を比較して、
共通して確認できる事実を中心にまとめてください。

関連記事に存在しない情報を追加してはいけません。

架空の情報は禁止です。

架空のURLは禁止です。

出典URLは必ず上記関連記事のURLだけを使用してください。


【本文】

400〜700文字程度。

自然なニュース記事として書いてください。

可能な範囲で、

・何が起きたのか
・いつ
・どこで
・誰が
・なぜ話題になったのか
・現在どうなっているのか
・必要な背景

を含めてください。


【見出し】

SNSで目を引く見出しにしてください。

ただし、

・嘘をつかない
・事実を歪めない
・過度に煽らない

こと。


【過去記事】

以下と同じニュースは避けてください。

${previousTitles.join('\n')}


【カテゴリー】

以下から1つ。

海外事件
海外ニュース
政治・社会
芸能
YouTuber・インフルエンサー
スキャンダル
雑学
その他


【出力】

必ずJSONのみ。

{
  "articles": [
    {
      "title": "記事タイトル",
      "summary": "記事本文",
      "category": "海外ニュース",
      "sources": [
        {
          "name": "媒体名",
          "url": "実際の関連記事URL"
        }
      ]
    }
  ]
}

`;



  const data =
    await callGemini(
      prompt
    );


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
      'Geminiから記事が返されませんでした'
    );

  }


  const result =
    parseGeminiJson(
      text
    );


  if (
    !Array.isArray(
      result.articles
    )
  ) {

    throw new Error(
      'articlesが配列ではありません'
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
   出典URL検証
========================================================= */

function validateSources(
  article,
  relatedArticles
) {

  const validUrls =
    new Set(
      relatedArticles.map(
        item =>
          item.url
      )
    );


  const sources =
    [];


  for (
    const source
    of article.sources || []
  ) {

    if (
      !source ||
      !source.name ||
      !source.url
    ) {

      continue;

    }


    let parsedUrl;


    try {

      parsedUrl =
        new URL(
          source.url
        );

    } catch {

      continue;

    }


    if (
      parsedUrl.protocol !==
        'http:' &&
      parsedUrl.protocol !==
        'https:'
    ) {

      continue;

    }


    if (
      !validUrls.has(
        source.url
      )
    ) {

      console.log(
        `⚠️ 関連記事に存在しない出典を除外: ${source.url}`
      );

      continue;

    }


    if (
      !sources.some(
        item =>
          item.url ===
          source.url
      )
    ) {

      sources.push({

        name:
          source.name,

        url:
          source.url

      });

    }

  }


  /*
   * Geminiが出典を1件も返さなかった場合、
   * 関連記事から自動補完
   */

  if (
    sources.length === 0
  ) {

    for (
      const article
      of relatedArticles
    ) {

      sources.push({

        name:
          article.source,

        url:
          article.url

      });

      break;

    }

  }


  return sources;

}


/* =========================================================
   Firebase投稿
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


  if (!threadRes.ok) {

    throw new Error(
      `スレッド作成失敗: HTTP ${threadRes.status}`
    );

  }


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
   メイン
========================================================= */

async function main() {

  console.log(
    '🤖 Ecstasy ニュースBot 開始'
  );


  /* Firebase */

  const token =
    await getFirebaseToken();


  /* 過去記事 */

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
     既存ニュースURL
  ======================================================= */

  const existingUrls =
    new Set(
      existingArticles
        .map(
          item =>
            item.url
        )
        .filter(Boolean)
    );


  /*
   * 既存記事のURLを候補から除外
   *
   * これにより同じニュースを再選択しにくくする
   */

  const freshCandidates =
    allCandidates.filter(
      article =>
        !existingUrls.has(
          article.url
        )
    );


  /*
   * 全部既存だった場合は終了
   */

  if (
    freshCandidates.length ===
    0
  ) {

    console.log(
      '⏭️ 新しいニュース候補がありません'
    );

    return;

  }


  console.log(
    `🆕 新規候補: ${freshCandidates.length}件`
  );


  /* =======================================================
     1つの出来事を選択
  ======================================================= */

  console.log(
    `🤖 ${freshCandidates.length}件から最も興味深い出来事を選択中...`
  );


  let selection;


  try {

    selection =
      await selectInterestingEvent(
        freshCandidates,
        existingArticles
      );

  } catch (error) {

    console.error(
      `❌ 出来事選択失敗: ${error.message}`
    );

    throw error;

  }


  console.log(
    `🎯 選択された出来事: ${selection.event.title}`
  );


  console.log(
    `💡 選択理由: ${selection.event.reason}`
  );


  console.log(
    `📰 基準記事: ${selection.baseArticle.title}`
  );


  /* =======================================================
     同じ出来事の記事を探す
  ======================================================= */

  console.log(
    '🔎 候補の中から同じ出来事を報じている記事を検索中...'
  );


  let relatedArticles;


  try {

    relatedArticles =
      await findRelatedArticles(
        freshCandidates,
        selection.event,
        selection.baseArticle
      );

  } catch (error) {

    console.error(
      `❌ 関連記事検索失敗: ${error.message}`
    );

    throw error;

  }


  console.log(
    `🔎 同じ出来事の記事を ${relatedArticles.length}件発見`
  );


  for (
    const article
    of relatedArticles
  ) {

    console.log(
      `   📰 ${article.source}: ${article.title}`
    );

  }


  /* =======================================================
     ★重要
     
     1件でも投稿する
     
     0件だけ停止
  ======================================================= */

  if (
    relatedArticles.length <
    CONFIG.MIN_RELATED_ARTICLES
  ) {

    console.log(
      '⚠️ 関連記事が見つからなかったため今回は投稿しません'
    );

    return;

  }


  /* =======================================================
     1つの記事へ統合
  ======================================================= */

  console.log(
    `✍️ ${relatedArticles.length}件の記事を1つの記事へ統合中...`
  );


  let articles;


  try {

    articles =
      await generateFinalArticle(
        relatedArticles,
        selection.event,
        existingArticles
      );

  } catch (error) {

    console.error(
      `❌ 記事生成失敗: ${error.message}`
    );

    throw error;

  }


  console.log(
    `🤖 ${articles.length}件の記事を生成`
  );


  /* =======================================================
     Firebase投稿
  ======================================================= */

  let posted =
    0;


  for (
    const article
    of articles
  ) {

    try {

      /* 出典検証 */

      const validSources =
        validateSources(
          article,
          relatedArticles
        );


      /*
       * 1件でもあればOK
       */

      if (
        validSources.length ===
        0
      ) {

        console.log(
          `⚠️ 出典が確認できないため投稿スキップ: ${article.title}`
        );

        continue;

      }


      article.sources =
        validSources;


      /* ===================================================
         既存URL確認
      =================================================== */

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

        /*
         * 関連記事の一部が既存でも、
         * 全て既存とは限らないので、
         * ここではタイトル重複を優先する。
         */

        const sameTitle =
          existingArticles.some(
            old =>
              old.title &&
              old.title ===
                article.title
          );


        if (
          sameTitle
        ) {

          console.log(
            `⏭️ 同じタイトルの記事が既に存在: ${article.title}`
          );

          continue;

        }

      }


      /* 投稿 */

      await postToFirebase(
        token,
        article
      );


      posted++;


      await sleep(
        3000
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