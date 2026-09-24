in highp float v_projection_tile_x;

// On globe the z0 tile's buffer wraps around the planet onto the tile itself, drawing geometry near the antimeridian twice.
// To avoid this, we discard fragments beyond the tile's X extent (0..8192) when enabled for the tile.
// The range test is half-open so that both sides of the antimeridian tile the seam exactly, without overlap.
void clipAntimeridian() {
    if (u_projection_clip_antimeridian != 0 && (v_projection_tile_x < 0.0 || v_projection_tile_x >= 8192.0)) {
        discard;
    }
}

#define POLE_BLUR_GROWTH 4.0

// The tiles' edge pixels around a pole, blurred more the closer to the pole.
vec4 poleCapColor(vec2 pole, sampler2D north, sampler2D south, sampler2D coverage, out float weight) {
    float towardsPole = abs(pole.y);
    float fromPole = max(1.0 - towardsPole, 1e-4);
    float blurTexels = POLE_BLUR_GROWTH * towardsPole / (6.283185307179586 * fromPole) * float(textureSize(north, 0).x);
    float lod = log2(max(blurTexels, 1.0));
    vec2 uv = vec2(pole.x / fromPole, 0.5);
    float covered = pole.y > 0.0 ? textureLod(coverage, uv, lod).r : textureLod(coverage, uv, lod).g;
    weight = clamp(blurTexels, 0.0, 1.0) * clamp(covered * 16.0, 0.0, 1.0);
    vec4 color = pole.y > 0.0 ? textureLod(north, uv, lod) : textureLod(south, uv, lod);
    return color / max(covered, 1.0 / 255.0);
}
