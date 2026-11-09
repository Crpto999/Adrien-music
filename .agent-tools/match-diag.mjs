// Replicates the app's matching pipeline against live NetEase search
// results, for each "True Colors" the user actually played.
const NOISE = new Set([
  "official","video","videoclip","music","audio","lyrics","lyric","hd","hq","4k","mv",
  "visualizer","visualiser","explicit","clean","remastered","remaster","version",
  "feat","ft","featuring","with","the","a","an","and","of","topic",
  "高音质","超清","无损","完整版","官方","高品","超品","臻品","全景声","母带","试听","纯享","伴奏","消音",
]);
const VARIANT = new Set([
  "remix","cover","live","karaoke","instrumental","sped","slowed","reverb","nightcore",
  "acoustic","8d","mashup","edit","reprise","翻唱","现场","钢琴","纯音乐","加速","减速","音效","影视","抖音","卡点",
]);
const tokens = (s) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean);
const significant = (s) => tokens(s).filter((t) => !NOISE.has(t));

function scoreMatch(c, h) {
  const want = significant(h.title);
  const got = new Set(significant(c.title));
  if (want.length === 0) return null;
  const coverage = want.filter((t) => got.has(t)).length / want.length;
  if (coverage < 0.75) return null;
  const wantSet = new Set(want);
  for (const t of got) if (VARIANT.has(t) && !wantSet.has(t)) return null;

  const names = (h.artists ?? []).filter(Boolean);
  let artistFrac = 0;
  if (names.length > 0) {
    const hay = [c.title, c.artistLine ?? "", ...(c.artists ?? [])].join(" ").toLowerCase();
    artistFrac = names.filter((n) => hay.includes(n.toLowerCase())).length / names.length;
  }
  const artistOk = artistFrac >= 0.5;

  const d0 = h.duration, d1 = c.duration;
  const known = !!d0 && !!d1;
  const diff = known ? Math.abs(d0 - d1) : Infinity;
  const tol = Math.max(5, (d0 ?? 0) * 0.03);
  if (known && diff > tol) return null;
  if (!artistOk && !(known && diff <= 5)) return null;

  let total = coverage * 3 + artistFrac * 2;
  total += known ? (diff <= 3 ? 2 : 1) : 0.3;
  return total;
}
function artistsAgree(c, h) {
  const names = (h.artists ?? []).filter(Boolean);
  if (names.length === 0) return true;
  const hay = [c.title, c.artistLine ?? "", ...(c.artists ?? [])].join(" ").toLowerCase();
  return names.filter((n) => hay.includes(n.toLowerCase())).length / names.length >= 0.5;
}

async function search(q, limit = 10) {
  const r = await fetch(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=${limit}&offset=0`, {
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/" },
  });
  const j = await r.json();
  return (j.result?.songs ?? []).map((s) => ({
    id: String(s.id), title: s.name, artists: s.artists.map((a) => a.name),
    duration: Math.round(s.duration / 1000),
  }));
}

// The tracks the user actually played, with the metadata the app holds.
const tracks = [
  { label: "Wiz Khalifa (Topic)",   title: "True Colors (feat. Nicki Minaj)", artists: ["Wiz Khalifa"],   duration: 255 },
  { label: "Sammy Porter (Topic)",  title: "True Colours (WiDE AWAKE Remix)",  artists: ["Sammy Porter"],  duration: 197 },
  { label: "Shuba (Topic)",         title: "True Colors",                      artists: ["Shuba"],         duration: 176 },
  { label: "Taemoe (Topic)",        title: "True Colors",                      artists: ["Taemoe"],        duration: 128 },
  { label: "Clous85 (Topic)",       title: "True Colors",                      artists: ["Clous85"],       duration: 159 },
];

const THRESHOLD = 5;
for (const t of tracks) {
  const query = [t.title, ...t.artists].join(" ").trim();
  const songs = await search(query, 10);
  const scored = songs.map((s) => ({
    s, score: scoreMatch(s, t), ok: artistsAgree(s, t),
  }));
  const passing = scored.filter((r) => r.score !== null && r.score >= THRESHOLD && r.ok);
  console.log(`\n=== ${t.label} — query: "${query}" (yt dur ${t.duration}s)`);
  console.log(`    search returned ${songs.length} rows`);
  for (const r of scored.slice(0, 5)) {
    console.log(`      ${r.s.id} | ${r.s.title} | ${r.s.artists.join(",")} | ${r.s.duration}s -> score=${r.score} artistOk=${r.ok}`);
  }
  console.log(`    MATCH: ${passing.length ? passing[0].s.id + " (" + passing[0].s.title + ")" : "*** NONE ***"}`);
}
