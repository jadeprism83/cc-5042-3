// GLSL for the instanced SDF text renderer. The distance convention must stay
// in lockstep with shared/sdf.mjs:
//   byte 128 == distance 0, byte 255 == +rangeTexels (inside),
//   byte 0 == -rangeTexels (outside). Values are sampled from an R8 texture,
//   normalised to [0,1], then decoded to texels and scaled by
//   (texels per em / screen pixels per em).
//
// Anti-aliasing is a screen-space ramp of `edgeWidthPx` pixels, so the ramp is
// constant on screen at every size. That is a deliberate choice: the tile's
// texel density is fixed, so large sizes interpolate the field more smoothly
// (softer, wider-than-one-pixel transitions only from field band limiting),
// and small sizes must not use a wider ramp or they would look bolder than the
// outline. The renderer's on-screen coverage is compared against exact outline
// rasterisation in the report, not asserted to be identical at all sizes.

export const TEXT_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;   // unit quad, (0,0)..(1,1)
layout(location=1) in vec4 a_rect;     // x, y, w, h in CSS pixels (top-left origin)
layout(location=2) in vec4 a_uvrect;   // u0, v0, du, dv in atlas texels
layout(location=3) in vec4 a_color;    // rgba, straight (not premultiplied)
layout(location=4) in vec2 a_screen;   // screen size in CSS pixels
layout(location=5) in vec3 a_glyph;    // rangeTexels, texelsPerEm, pxPerEm
out vec2 v_uv;
out vec4 v_color;
flat out vec4 v_uvrect;
flat out vec3 v_glyph;
void main() {
  vec2 px = a_rect.xy + a_corner * a_rect.zw;
  vec2 ndc = vec2(px.x / a_screen.x * 2.0 - 1.0, 1.0 - px.y / a_screen.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = a_uvrect.xy + a_corner * a_uvrect.zw;
  v_uvrect = a_uvrect;
  v_color = a_color;
  v_glyph = a_glyph;
}
`;

export const TEXT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
in vec4 v_color;
flat in vec4 v_uvrect;
flat in vec3 v_glyph;   // rangeTexels, texelsPerEm, pxPerEm
uniform sampler2D u_atlas;
uniform vec2 u_atlasSize;      // atlas width, height in texels
uniform float u_edgeWidthPx;   // screen-space AA ramp width, default 1.0
uniform int u_debug;           // 0 = text, 1 = raw field, 2 = raw threshold
out vec4 outColor;

// v_uv is in atlas texels; the sampler needs normalised coordinates.
float sampleField(vec2 texelUv) {
  return texture(u_atlas, texelUv / u_atlasSize).r;
}

// Decode: [0,1] sample -> signed distance in screen pixels.
// 128 neutral, 127 full swing over +-rangeTexels tile texels. Encoding and
// decode are mirrored in shared/sdf.mjs; a test asserts they agree.
float distancePx(vec2 uv) {
  float b = sampleField(uv);
  float texels = ((b * 255.0) - 128.0) / 127.0 * v_glyph.x;
  // texels of atlas grid -> em -> screen px
  return (texels / v_glyph.y) * v_glyph.z;
}

void main() {
  // Reject samples outside this glyph's own tile rect, so a bilinear tap that
  // lands on a neighbouring tile can never contribute.
  if (v_uv.x < v_uvrect.x || v_uv.y < v_uvrect.y ||
      v_uv.x > v_uvrect.x + v_uvrect.z || v_uv.y > v_uvrect.y + v_uvrect.w) discard;

  float dPx = distancePx(v_uv);

  if (u_debug == 1) {
    float halfSpanPx = (v_glyph.x / v_glyph.y) * v_glyph.z;
    float g = clamp(dPx / halfSpanPx * 0.5 + 0.5, 0.0, 1.0);
    outColor = vec4(vec3(g), 1.0);
    return;
  }
  if (u_debug == 2) {
    outColor = vec4(v_color.rgb, v_color.a * step(0.0, dPx));
    return;
  }

  float alpha = clamp(dPx / u_edgeWidthPx + 0.5, 0.0, 1.0);
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

// Fullscreen pass that blits the atlas into the inspector canvas with an
// exposure of the raw bytes (no filtering across texel borders).
export const INSPECT_VERT = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const INSPECT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_atlas;
uniform vec3 u_bg;
uniform int u_mode;        // 0 = raw R8, 1 = signed field tint, 2 = coverage
uniform float u_rangeTexels;
uniform float u_texelsPerEm;
uniform float u_pxPerEm;
uniform float u_zoom;
out vec4 outColor;
void main() {
  vec2 uv = v_uv;
  float b = texture(u_atlas, uv).r;
  if (u_mode == 0) {
    outColor = vec4(vec3(b), 1.0);
  } else if (u_mode == 1) {
    float t = (b * 255.0 - 128.0) / 127.0;  // -1..1
    vec3 out_ = t >= 0.0 ? mix(vec3(0.5), vec3(0.1, 0.8, 0.75), t)
                         : mix(vec3(0.5), vec3(0.95, 0.35, 0.2), -t);
    // One-pixel contour wherever the decoded distance crosses zero. fwidth
    // gives the per-pixel change of t, so the line stays one screen pixel wide
    // at any magnification; this mode samples the atlas bilinearly.
    float w = max(fwidth(t), 1.0 / 255.0);
    if (abs(t) < w * 0.75) out_ = vec3(0.98, 0.96, 0.9);
    outColor = vec4(out_, 1.0);
  } else {
    float dPx = ((b * 255.0 - 128.0) / 127.0 * u_rangeTexels / u_texelsPerEm) * u_pxPerEm;
    float a = clamp(dPx / 1.0 + 0.5, 0.0, 1.0);
    outColor = vec4(vec3(0.97, 0.96, 0.93) * a, 1.0);
  }
}
`;
