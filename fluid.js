/* ───────────────────────────────────────────────────────────
   fluid.js — 藍渦 共用流體引擎
   Stable Fluids (Jos Stam, 1999) 即時不可壓縮流體。
   算子分裂:渦度約束 → 散度 → 壓力(Jacobi)→ 梯度投影 → 對流。
   速度場低解析、染料場高解析;以 multiply 染入和紙。

   用法:
     const sim = Fluid.create(canvas, { params:{...} });
     sim.params.CURL = 24;     // 即時生效
     sim.reset();              // 淨水
     sim.reinit();             // 變更解析度後重建緩衝
     sim.drop();               // 隨機滴一滴
   ─────────────────────────────────────────────────────────── */
window.Fluid = (function(){
'use strict';

const DEFAULTS = {
  SIM_RES: 140,                 // 模擬(速度場)解析度 — 變更需 reinit
  DYE_RES: 720,                 // 染料(墨色)解析度   — 變更需 reinit
  DENSITY_DISSIPATION: 0.42,    // 墨痕留存(越大越快沉澱消散)
  VELOCITY_DISSIPATION: 0.25,   // 流場黏滯(越大越快靜止)
  PRESSURE_ITER: 24,            // 壓力 Jacobi 迭代(投影精度)
  CURL: 18,                     // 渦度約束(墨絲捲曲)
  SPLAT_RADIUS: 0.0035,         // 筆觸大小
  SPLAT_FORCE: 5400,            // 注入力道
  EDGE: 0.7,                    // 聚邊暈染(墨水在紙上的邊界濃聚)
  COLOR: [0.09, 0.16, 0.27],    // 濃滴基準色(線性、會被 strength 放大)
  INK_GAIN: 1.0,                // 整體墨量增益
  PAUSED: false
};

function create(canvas, opts){
  opts = opts || {};
  const params = Object.assign({}, DEFAULTS, opts.params || {});
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let gl = canvas.getContext('webgl2',{alpha:false,depth:false,stencil:false,antialias:false});
  let isGL2 = !!gl;
  if(!gl) gl = canvas.getContext('webgl',{alpha:false,depth:false,stencil:false,antialias:false});
  if(!gl){ throw new Error('WebGL unsupported'); }

  let halfFloat, supportLinear;
  if(isGL2){
    gl.getExtension('EXT_color_buffer_float');
    supportLinear = !!gl.getExtension('OES_texture_float_linear');
  }else{
    halfFloat = gl.getExtension('OES_texture_half_float');
    supportLinear = !!gl.getExtension('OES_texture_half_float_linear');
  }
  const HALF = isGL2 ? gl.HALF_FLOAT : (halfFloat && halfFloat.HALF_FLOAT_OES);
  const RGBA16F=isGL2?gl.RGBA16F:gl.RGBA, RG16F=isGL2?gl.RG16F:gl.RGBA, R16F=isGL2?gl.R16F:gl.RGBA;
  const RG=isGL2?gl.RG:gl.RGBA, RED=isGL2?gl.RED:gl.RGBA;

  function compile(type,src){
    const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s),src);
    return s;
  }
  const vertSrc=`
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv,vL,vR,vT,vB;
  uniform vec2 texelSize;
  void main(){
    vUv=aPosition*.5+.5;
    vL=vUv-vec2(texelSize.x,0.); vR=vUv+vec2(texelSize.x,0.);
    vT=vUv+vec2(0.,texelSize.y); vB=vUv-vec2(0.,texelSize.y);
    gl_Position=vec4(aPosition,0.,1.);
  }`;
  const baseVert=compile(gl.VERTEX_SHADER,vertSrc);
  function program(frag){
    const p=gl.createProgram();
    gl.attachShader(p,baseVert); gl.attachShader(p,compile(gl.FRAGMENT_SHADER,frag));
    gl.bindAttribLocation(p,0,'aPosition'); gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(p));
    const u={}, n=gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);
    for(let i=0;i<n;i++){const nm=gl.getActiveUniform(p,i).name; u[nm]=gl.getUniformLocation(p,nm);}
    return {u, bind(){gl.useProgram(p);}};
  }

  const clearFrag=`precision mediump float;varying vec2 vUv;uniform sampler2D uTexture;uniform float value;
  void main(){gl_FragColor=value*texture2D(uTexture,vUv);}`;

  const splatFrag=`precision highp float;varying vec2 vUv;
  uniform sampler2D uTarget;uniform float aspectRatio;uniform vec3 color;uniform vec2 point;uniform float radius;
  void main(){vec2 p=vUv-point;p.x*=aspectRatio;
    vec3 s=exp(-dot(p,p)/radius)*color;
    gl_FragColor=vec4(texture2D(uTarget,vUv).xyz+s,1.);}`;

  const advectFrag=`precision highp float;varying vec2 vUv;
  uniform sampler2D uVelocity,uSource;uniform vec2 texelSize,dyeTexelSize;uniform float dt,dissipation;uniform bool linearFilter;
  vec4 bilerp(sampler2D s,vec2 uv,vec2 ts){
    vec2 st=uv/ts-.5;vec2 i=floor(st),f=fract(st);
    vec4 a=texture2D(s,(i+vec2(.5,.5))*ts),b=texture2D(s,(i+vec2(1.5,.5))*ts);
    vec4 c=texture2D(s,(i+vec2(.5,1.5))*ts),d=texture2D(s,(i+vec2(1.5,1.5))*ts);
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
  void main(){
    vec2 coord=vUv-dt*bilerp(uVelocity,vUv,texelSize).xy*texelSize;
    vec4 r=linearFilter?texture2D(uSource,coord):bilerp(uSource,coord,dyeTexelSize);
    gl_FragColor=r/(1.+dissipation*dt);}`;

  const divergenceFrag=`precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity;
  void main(){float L=texture2D(uVelocity,vL).x,R=texture2D(uVelocity,vR).x,T=texture2D(uVelocity,vT).y,B=texture2D(uVelocity,vB).y;
    vec2 C=texture2D(uVelocity,vUv).xy;
    if(vL.x<0.)L=-C.x; if(vR.x>1.)R=-C.x; if(vT.y>1.)T=-C.y; if(vB.y<0.)B=-C.y;
    gl_FragColor=vec4(.5*(R-L+T-B),0.,0.,1.);}`;

  const curlFrag=`precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity;
  void main(){float L=texture2D(uVelocity,vL).y,R=texture2D(uVelocity,vR).y,T=texture2D(uVelocity,vT).x,B=texture2D(uVelocity,vB).x;
    gl_FragColor=vec4(.5*(R-L-T+B),0.,0.,1.);}`;

  const vorticityFrag=`precision highp float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity,uCurl;uniform float curl,dt;
  void main(){float L=texture2D(uCurl,vL).x,R=texture2D(uCurl,vR).x,T=texture2D(uCurl,vT).x,B=texture2D(uCurl,vB).x,C=texture2D(uCurl,vUv).x;
    vec2 force=.5*vec2(abs(T)-abs(B),abs(R)-abs(L));
    force/=length(force)+.0001; force*=curl*C; force.y*=-1.;
    vec2 vel=texture2D(uVelocity,vUv).xy+force*dt;
    gl_FragColor=vec4(clamp(vel,-1000.,1000.),0.,1.);}`;

  const pressureFrag=`precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uPressure,uDivergence;
  void main(){float L=texture2D(uPressure,vL).x,R=texture2D(uPressure,vR).x,T=texture2D(uPressure,vT).x,B=texture2D(uPressure,vB).x,div=texture2D(uDivergence,vUv).x;
    gl_FragColor=vec4((L+R+T+B-div)*.25,0.,0.,1.);}`;

  const gradientFrag=`precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uPressure,uVelocity;
  void main(){float L=texture2D(uPressure,vL).x,R=texture2D(uPressure,vR).x,T=texture2D(uPressure,vT).x,B=texture2D(uPressure,vB).x;
    vec2 vel=texture2D(uVelocity,vUv).xy-vec2(R-L,T-B);
    gl_FragColor=vec4(vel,0.,1.);}`;

  // 顯示:白底 − 墨量,並以鄰點差分在邊界處加深,模擬墨水聚邊暈染
  const displayFrag=`precision highp float;varying vec2 vUv;uniform sampler2D uTexture;uniform vec2 texelSize;uniform float edge;
  void main(){
    vec3 c=texture2D(uTexture,vUv).rgb;
    float here=dot(c,vec3(.333));
    float lo=dot(texture2D(uTexture,vUv-vec2(texelSize.x,0.)).rgb,vec3(.333));
    float ro=dot(texture2D(uTexture,vUv+vec2(texelSize.x,0.)).rgb,vec3(.333));
    float to=dot(texture2D(uTexture,vUv+vec2(0.,texelSize.y)).rgb,vec3(.333));
    float bo=dot(texture2D(uTexture,vUv-vec2(0.,texelSize.y)).rgb,vec3(.333));
    float e=max(0.,(here*4.-lo-ro-to-bo));
    vec3 ink=clamp(c+e*edge,0.,1.2);
    gl_FragColor=vec4(vec3(1.)-ink,1.);
  }`;

  const progClear=program(clearFrag), progSplat=program(splatFrag), progAdvect=program(advectFrag);
  const progDivergence=program(divergenceFrag), progCurl=program(curlFrag), progVorticity=program(vorticityFrag);
  const progPressure=program(pressureFrag), progGradient=program(gradientFrag), progDisplay=program(displayFrag);

  const quad=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,quad);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const eidx=gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,eidx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,2,1,3]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);

  function blit(t){
    if(t==null){gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);gl.bindFramebuffer(gl.FRAMEBUFFER,null);}
    else{gl.viewport(0,0,t.w,t.h);gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo);}
    gl.drawElements(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0);
  }

  const filtering=supportLinear?gl.LINEAR:gl.NEAREST;
  function createFBO(w,h,internal,format){
    const tex=gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filtering);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filtering);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,internal,w,h,0,format,HALF,null);
    const fbo=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    return {tex,fbo,w,h,texel:[1/w,1/h],attach(id){gl.activeTexture(gl.TEXTURE0+id);gl.bindTexture(gl.TEXTURE_2D,tex);return id;}};
  }
  function doubleFBO(w,h,internal,format){
    let a=createFBO(w,h,internal,format),b=createFBO(w,h,internal,format);
    return {get read(){return a},get write(){return b},swap(){const t=a;a=b;b=t},w,h,texel:a.texel};
  }

  let simW,simH,dyeW,dyeH,velocity,dye,divergence,curlFBO,pressure;
  function initFBOs(){
    const aspect=canvas.width/canvas.height;
    function res(base){let w=base,h=base; if(aspect>1)w=Math.round(base*aspect); else h=Math.round(base/aspect); return [w,h];}
    [simW,simH]=res(params.SIM_RES); [dyeW,dyeH]=res(params.DYE_RES);
    velocity=doubleFBO(simW,simH,RG16F,RG);
    dye=doubleFBO(dyeW,dyeH,RGBA16F,gl.RGBA);
    divergence=createFBO(simW,simH,R16F,RED);
    curlFBO=createFBO(simW,simH,R16F,RED);
    pressure=doubleFBO(simW,simH,R16F,RED);
  }
  function resize(){
    const dpr=Math.min(devicePixelRatio||1,2);
    const w=Math.floor(innerWidth*dpr),h=Math.floor(innerHeight*dpr);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;initFBOs();}
  }
  resize(); addEventListener('resize',resize);

  function inkColor(strength){
    const c=params.COLOR, j=()=>(Math.random()-0.5)*0.02, g=params.INK_GAIN;
    return [(c[0]+j())*strength*g,(c[1]+j())*strength*g,(c[2]+j())*strength*g];
  }

  function splat(x,y,dx,dy,color,radius){
    progSplat.bind();
    gl.uniform1i(progSplat.u.uTarget,velocity.read.attach(0));
    gl.uniform1f(progSplat.u.aspectRatio,canvas.width/canvas.height);
    gl.uniform2f(progSplat.u.point,x,y);
    gl.uniform3f(progSplat.u.color,dx,dy,0);
    gl.uniform1f(progSplat.u.radius,radius);
    blit(velocity.write); velocity.swap();
    gl.uniform1i(progSplat.u.uTarget,dye.read.attach(0));
    gl.uniform3f(progSplat.u.color,color[0],color[1],color[2]);
    blit(dye.write); dye.swap();
  }

  function step(dt){
    gl.disable(gl.BLEND);
    progCurl.bind();
    gl.uniform2f(progCurl.u.texelSize,velocity.texel[0],velocity.texel[1]);
    gl.uniform1i(progCurl.u.uVelocity,velocity.read.attach(0)); blit(curlFBO);

    progVorticity.bind();
    gl.uniform2f(progVorticity.u.texelSize,velocity.texel[0],velocity.texel[1]);
    gl.uniform1i(progVorticity.u.uVelocity,velocity.read.attach(0));
    gl.uniform1i(progVorticity.u.uCurl,curlFBO.attach(1));
    gl.uniform1f(progVorticity.u.curl,params.CURL); gl.uniform1f(progVorticity.u.dt,dt);
    blit(velocity.write); velocity.swap();

    progDivergence.bind();
    gl.uniform2f(progDivergence.u.texelSize,velocity.texel[0],velocity.texel[1]);
    gl.uniform1i(progDivergence.u.uVelocity,velocity.read.attach(0)); blit(divergence);

    progClear.bind();
    gl.uniform1i(progClear.u.uTexture,pressure.read.attach(0));
    gl.uniform1f(progClear.u.value,0.8); blit(pressure.write); pressure.swap();

    progPressure.bind();
    gl.uniform2f(progPressure.u.texelSize,velocity.texel[0],velocity.texel[1]);
    gl.uniform1i(progPressure.u.uDivergence,divergence.attach(0));
    const iters=Math.max(1,Math.round(params.PRESSURE_ITER));
    for(let i=0;i<iters;i++){
      gl.uniform1i(progPressure.u.uPressure,pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    progGradient.bind();
    gl.uniform2f(progGradient.u.texelSize,velocity.texel[0],velocity.texel[1]);
    gl.uniform1i(progGradient.u.uPressure,pressure.read.attach(0));
    gl.uniform1i(progGradient.u.uVelocity,velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    progAdvect.bind();
    gl.uniform2f(progAdvect.u.texelSize,velocity.texel[0],velocity.texel[1]);
    gl.uniform2f(progAdvect.u.dyeTexelSize,velocity.texel[0],velocity.texel[1]);
    gl.uniform1i(progAdvect.u.linearFilter,supportLinear?1:0);
    gl.uniform1i(progAdvect.u.uVelocity,velocity.read.attach(0));
    gl.uniform1i(progAdvect.u.uSource,velocity.read.attach(0));
    gl.uniform1f(progAdvect.u.dt,dt);
    gl.uniform1f(progAdvect.u.dissipation,params.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    gl.uniform2f(progAdvect.u.dyeTexelSize,dye.texel[0],dye.texel[1]);
    gl.uniform1i(progAdvect.u.uVelocity,velocity.read.attach(0));
    gl.uniform1i(progAdvect.u.uSource,dye.read.attach(1));
    gl.uniform1f(progAdvect.u.dissipation,params.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }

  function render(){
    progDisplay.bind();
    gl.uniform2f(progDisplay.u.texelSize,dye.texel[0],dye.texel[1]);
    gl.uniform1f(progDisplay.u.edge,params.EDGE);
    gl.uniform1i(progDisplay.u.uTexture,dye.read.attach(0));
    blit(null);
  }

  // ── 指標互動 ──
  const pointer={x:.5,y:.5,px:.5,py:.5,down:false,moved:false};
  let onFirstInteract = opts.onFirstInteract || null;
  let interacted=false;
  function updatePointer(cx,cy,down){
    pointer.px=pointer.x; pointer.py=pointer.y;
    pointer.x=cx/innerWidth; pointer.y=1-cy/innerHeight; pointer.moved=true;
    if(down!==undefined)pointer.down=down;
    if(!interacted){interacted=true; if(onFirstInteract) onFirstInteract();}
  }
  const target = opts.interactionTarget || window;
  target.addEventListener('mousemove',e=>updatePointer(e.clientX,e.clientY));
  target.addEventListener('mousedown',e=>updatePointer(e.clientX,e.clientY,true));
  target.addEventListener('mouseup',()=>pointer.down=false);
  target.addEventListener('touchstart',e=>{const t=e.touches[0];updatePointer(t.clientX,t.clientY,true);},{passive:true});
  target.addEventListener('touchmove',e=>{const t=e.touches[0];updatePointer(t.clientX,t.clientY);},{passive:true});
  target.addEventListener('touchend',()=>pointer.down=false);

  function applyPointer(){
    if(!pointer.moved)return; pointer.moved=false;
    const dx=(pointer.x-pointer.px)*params.SPLAT_FORCE, dy=(pointer.y-pointer.py)*params.SPLAT_FORCE;
    if(Math.abs(dx)<0.01&&Math.abs(dy)<0.01&&!pointer.down)return;
    if(pointer.down) splat(pointer.x,pointer.y,dx,dy,inkColor(1.4),params.SPLAT_RADIUS*2.6);
    else splat(pointer.x,pointer.y,dx,dy,inkColor(0.045),params.SPLAT_RADIUS);
  }

  function reset(){
    progClear.bind(); gl.uniform1f(progClear.u.value,0);
    gl.uniform1i(progClear.u.uTexture,dye.read.attach(0)); blit(dye.write); dye.swap();
    gl.uniform1i(progClear.u.uTexture,velocity.read.attach(0)); blit(velocity.write); velocity.swap();
  }

  function drop(x,y){
    x = (x==null) ? 0.5+(Math.random()-.5)*0.4 : x;
    y = (y==null) ? 0.5+(Math.random()-.5)*0.4 : y;
    const a=Math.random()*Math.PI*2;
    splat(x,y,Math.cos(a)*440,Math.sin(a)*440,inkColor(1.25),params.SPLAT_RADIUS*3.2);
  }

  function initialDrops(){
    const drops=[[.34,.6],[.56,.43],[.46,.67]];
    drops.forEach((d,i)=>setTimeout(()=>drop(d[0]+(Math.random()-.5)*.06,d[1]+(Math.random()-.5)*.06),350+i*620));
  }
  if(!reduceMotion) initialDrops();
  else drop(.45,.55);

  let last=performance.now();
  function frame(now){
    const dt=Math.min((now-last)/1000,1/60); last=now;
    applyPointer();
    if(!params.PAUSED && (!reduceMotion||pointer.down||pointer.moved)) step(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    params,
    reset,
    drop,
    reinit: initFBOs,
    isWebGL2: isGL2,
    get pointer(){ return pointer; }
  };
}

return { create, DEFAULTS };
})();
