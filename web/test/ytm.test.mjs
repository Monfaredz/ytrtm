import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeDuration,
  parseSearch,
  pick,
  validVideoId,
} from "../netlify/functions/ytm.js";

function player() {
  return {
    playabilityStatus: { status: "OK" },
    videoDetails: { title: "Test Song", lengthSeconds: "213" },
    streamingData: {
      hlsManifestUrl: "https://manifest.googlevideo.com/api/manifest/hls_playlist/x.m3u8",
      adaptiveFormats: [
        { itag: 251, url: "https://rr1.googlevideo.com/videoplayback?ipbits=0&expire=1764000000&itag=251" },
        { itag: 140, url: "https://rr1.googlevideo.com/videoplayback?ipbits=0&expire=1764000000&itag=140" },
        { itag: 137, url: "https://rr1.googlevideo.com/videoplayback?itag=137" },
      ],
    },
  };
}

test("picks AAC first", () => {
  assert.deepEqual(pick(player(), [140, 139, 251]), {
    itag: 140,
    url: "https://rr1.googlevideo.com/videoplayback?ipbits=0&expire=1764000000&itag=140",
  });
});

test("skips a preferred itag without a URL", () => {
  const p = player();
  p.streamingData.adaptiveFormats[1].url = null;
  assert.equal(pick(p, [140, 139, 251]).itag, 251);
});

test("falls back to any plain URL", () => {
  assert.equal(pick(player(), [139]).itag, 251);
});

test("ciphered responses yield null", () => {
  const p = player();
  for (const f of p.streamingData.adaptiveFormats) {
    f.url = null;
    f.signatureCipher = "s=abc";
  }
  assert.equal(pick(p, [140, 139, 251]), null);
});

test("missing streaming data yields null", () => {
  assert.equal(pick({}, [140]), null);
  assert.equal(pick(null, [140]), null);
});

test("a video id is 11 URL-safe characters", () => {
  assert.ok(validVideoId("dQw4w9WgXcQ"));
  assert.ok(validVideoId("abc_-123456"));
  assert.ok(!validVideoId("dQw4w9WgXc"));
  assert.ok(!validVideoId("dQw4w9WgXcQ&x=1"));
  assert.ok(!validVideoId("../x"));
});

test("durations look like a clock", () => {
  assert.ok(looksLikeDuration("3:20"));
  assert.ok(looksLikeDuration("1:02:03"));
  assert.ok(!looksLikeDuration("After Hours"));
  assert.ok(!looksLikeDuration("2024"));
});

function searchFixture() {
  return {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      musicShelfRenderer: {
                        contents: [
                          {
                            musicResponsiveListItemRenderer: {
                              playlistItemData: { videoId: "abc12345678" },
                              flexColumns: [
                                {
                                  musicResponsiveListItemFlexColumnRenderer: {
                                    text: { runs: [{ text: "Blinding Lights" }] },
                                  },
                                },
                                {
                                  musicResponsiveListItemFlexColumnRenderer: {
                                    text: {
                                      runs: [
                                        { text: "The Weeknd" },
                                        { text: " • " },
                                        { text: "After Hours" },
                                        { text: " • " },
                                        { text: "3:20" },
                                      ],
                                    },
                                  },
                                },
                              ],
                            },
                          },
                          {
                            musicResponsiveListItemRenderer: {
                              flexColumns: [
                                {
                                  musicResponsiveListItemFlexColumnRenderer: {
                                    text: {
                                      runs: [
                                        {
                                          text: "Only endpoint",
                                          navigationEndpoint: { watchEndpoint: { videoId: "xyz78945612" } },
                                        },
                                      ],
                                    },
                                  },
                                },
                              ],
                            },
                          },
                          {
                            musicResponsiveListItemRenderer: {
                              flexColumns: [
                                {
                                  musicResponsiveListItemFlexColumnRenderer: {
                                    text: { runs: [{ text: "No id at all" }] },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}

test("search rows become hits", () => {
  const hits = parseSearch(searchFixture());
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], {
    id: "abc12345678",
    title: "Blinding Lights",
    artist: "The Weeknd",
    duration: "3:20",
  });
  assert.equal(hits[1].id, "xyz78945612");
  assert.equal(hits[1].artist, "");
  assert.equal(hits[1].duration, "");
});

test("unexpected shapes are empty, not thrown", () => {
  assert.deepEqual(parseSearch({}), []);
  assert.deepEqual(parseSearch(null), []);
  assert.deepEqual(parseSearch({ contents: { tabbedSearchResultsRenderer: {} } }), []);
});
