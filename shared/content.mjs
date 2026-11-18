// Single source of truth for the pavilion tour copy. The atlas builder, the
// runtime layout, and the tests all consume these strings, so any character
// that can be drawn at runtime is guaranteed to have been audited.

export const FACES = ['sans-thin', 'sans-book', 'sans-bold', 'cjk-regular'];

export const TOUR = {
  meta: {
    title: '山水之间',
    titleEn: 'Between Mountains and Water',
    subtitle: '第三展厅 · 园林与时间',
    hall: '第三展厅',
    issue: '03',
    lead: '第三展厅以借景为线索，把山、水、器物与时间放进同一段步行路线。',
  },
  sections: [
    {
      no: '01',
      heading: '借景',
      headingEn: 'Borrowed Scenery',
      body: '园林从不把墙当作终点。窗洞、廊柱与水面把远处的山、邻家的树借入园中，让有限的空间拥有更远的边界。',
    },
    {
      no: '02',
      heading: '器物',
      headingEn: 'Objects',
      body: '案上的砚、瓶中的一枝、墙上的一幅手稿，都是时间留下的痕迹。请与展品保持距离，不要触摸展柜。',
    },
    {
      no: '03',
      heading: '时间',
      headingEn: 'Time',
      body: '开放时间：周二至周日 09:30–17:30；周一闭馆，法定节假日除外。最后入场时间为 16:45。',
    },
  ],
  notices: [
    '参观须知：展厅内请保持安静，请勿触摸展品；拍照请关闭闪光灯。',
    '服务台提供免费讲解预约、轮椅租借与寄存服务。',
    '出口位于展厅东侧，洗手间在二层，电梯近 2 号门。',
  ],
  captions: [
    '第一单元 · 借景 / Borrowed Scenery',
    '第二单元 · 器物 / Objects',
    '第三单元 · 时间 / Time',
  ],
  punctuation: '「山水之间」，……；：、。！？（）《》·—–“”‘’',
  latinSample: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  latinLower: 'abcdefghijklmnopqrstuvwxyz',
  numerals: '0123456789',
  glyphSample: 'Aa Ww Qq Rg &@%',
  glyphSampleCjk: '永展山园间馆',
  hero: '展',
  map: '平面图 · Floor Plan',
  arrows: '← ↑ → ↓',
};

export function tourStrings() {
  const out = [];
  const push = (s) => { if (typeof s === 'string') out.push(s); };
  push(TOUR.meta.title); push(TOUR.meta.titleEn); push(TOUR.meta.subtitle);
  push(TOUR.meta.hall); push(TOUR.meta.issue); push(TOUR.meta.lead);
  for (const s of TOUR.sections) { push(s.no); push(s.heading); push(s.headingEn); push(s.body); }
  for (const s of TOUR.notices) push(s);
  for (const s of TOUR.captions) push(s);
  push(TOUR.punctuation); push(TOUR.latinSample); push(TOUR.latinLower);
  push(TOUR.numerals); push(TOUR.glyphSample); push(TOUR.glyphSampleCjk);
  push(TOUR.hero); push(TOUR.map); push(TOUR.arrows);
  return out;
}

// ASCII printable is always included so any Latin text typed by a visitor
// renders without a font re-build.
export function requiredCodepoints() {
  const cps = new Set();
  for (let cp = 32; cp <= 126; cp++) cps.add(cp);
  for (const ch of TOUR.punctuation + '“”‘’…—–·「」（）《》、。，；：！？°') cps.add(ch.codePointAt(0));
  for (const s of tourStrings()) for (const ch of s) cps.add(ch.codePointAt(0));
  // A small core set of common exhibition words, so the wayfinding sample can
  // be edited a little without triggering an on-demand tile build.
  for (const ch of '欢迎光临请勿触摸展品保持安静拍照关闭闪光灯出口入口洗手间电梯服务台预约讲解轮椅寄存开放时间周一至周日闭馆免费谢谢合作参观须知') cps.add(ch.codePointAt(0));
  return [...cps].sort((a, b) => a - b);
}

export function isCjkCodepoint(cp) {
  return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x3000 && cp <= 0x303f);
}
