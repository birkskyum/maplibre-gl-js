uniform sampler2D u_texture;
uniform sampler2D u_table;
uniform vec2 u_latrange;
uniform float u_fog_ground_blend;
uniform float u_fog_ground_blend_opacity;
uniform bool u_is_globe_mode;

in vec2 v_texture_pos;
in float v_fog_depth;

void main() {
    vec4 slopes = texture(u_texture, vec2(v_texture_pos.x, 1.0 - v_texture_pos.y));
    if (slopes.a < 0.5 / 255.0) {
        fragColor = vec4(0.0);
        return;
    }

    // The slopes are premultiplied by how much of the texel a hillshade tile covers.
    float scaleFactor = cos(radians(mix(u_latrange[0], u_latrange[1], v_texture_pos.y)));
    vec2 deriv = (slopes.rg / slopes.a - 128.0 / 255.0) * 8.0 / scaleFactor;
    vec4 shade = texture(u_table, deriv / (1.0 + abs(deriv)) * 0.5 + 0.5) * slopes.a;

    if (!u_is_globe_mode && u_fog_ground_blend_opacity > 0.0 && v_fog_depth > u_fog_ground_blend) {
        float factor_fog = max(v_fog_depth - u_fog_ground_blend, 0.0) / (1.0 - u_fog_ground_blend);
        shade *= 1.0 - pow(factor_fog, 2.0) * u_fog_ground_blend_opacity;
    }
    fragColor = shade;
}
