#version 300 es
precision highp float;
precision highp sampler3D;
in vec3 v_cube;
uniform sampler3D	u_texture;
uniform float		u_size;
uniform float		u_steps;
uniform float		u_opacity;
uniform vec3		u_origin;
uniform vec3		u_light;
uniform float		u_flatten;
out vec4 fragColor;

vec2 intersectBox(vec3 ro, vec3 rd) {
    vec3 t0		= (vec3(-1) - ro) / rd;
    vec3 t1		= (vec3( 1) - ro) / rd;
    vec3 tmin	= min(t0, t1);
    vec3 tmax	= max(t0, t1);
    return vec2(
		max(max(tmin.x, tmin.y), tmin.z),
		min(min(tmax.x, tmax.y), tmax.z)
	);
}

vec4 sampleVolume(vec3 position) {
    return texture(u_texture, position * 0.5 + 0.5);
}

void main() {
    //fragColor = vec4(1,0,0,1);
	//return;

    vec3 rd		= normalize(v_cube - u_origin);
    vec2 bounds = intersectBox(u_origin, rd);
    if (bounds.x > bounds.y)
        discard;

    float steps = max(u_steps, 1.0);
	vec3 ray0 = u_origin + rd * bounds.x;
	vec3 dray = rd * (bounds.y - bounds.x) / steps;

    vec4 accum = vec4(0.0);
    for (int i = 0; i < 256; ++i) {
        if (float(i) >= steps || accum.a >= 0.95)
            break;

        vec3 samplePosition = ray0 + dray * float(i);
        vec3 voxelLocal		= fract((samplePosition * 0.5 + 0.5) * u_size) - 0.5;
		float voxelDist2	= dot(voxelLocal, voxelLocal);
        if (voxelDist2 > 0.5 * 0.5)
            continue;

        float b		= dot(voxelLocal, rd);
        float dt	= -b + sqrt(b * b - voxelDist2 + 0.5 * 0.5);
		voxelLocal += dt * rd;

		vec3 normal		= voxelLocal * 2.0;
		float diffuse	= max(dot(normal, u_light), 0.0);

		vec3 surfacePosition = samplePosition + rd * dt / (u_size * 0.5);
        vec3 viewDir	= normalize(surfacePosition - u_origin);
        vec3 halfDir	= normalize(u_light + viewDir);
        float specular	= pow(max(dot(normal, halfDir), 0.0), 64.0);

        vec4 samp	= sampleVolume(samplePosition);
        float alpha = samp.a * u_opacity;
        accum.rgb	+= (1.0 - accum.a) * (samp.rgb * diffuse + specular) * alpha;
        accum.a		+= (1.0 - accum.a) * alpha;
    }

    fragColor = accum;
}