/* LIHPS Motion Angle — orientation and planar inclinometer mathematics.
   Device Orientation spec: intrinsic Z(alpha)–X'(beta)–Y''(gamma).
   https://www.w3.org/TR/orientation-event/
   Device coordinates are ALWAYS portrait-native: x right, y screen top, z out.
   Angles below are in degrees. No anatomical axes are inferred. */
export const rad = deg => deg * Math.PI / 180;
export const deg = radian => radian * 180 / Math.PI;
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export function wrap180(angle) { return ((angle + 180) % 360 + 360) % 360 - 180; }
export function validOrientation(a,b,g) { return [a,b,g].every(Number.isFinite); }

export function rotationMatrix(alpha, beta, gamma) {
  const a=rad(alpha), b=rad(beta), g=rad(gamma);
  const ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b),cg=Math.cos(g),sg=Math.sin(g);
  return [
    [ca*cg-sa*sb*sg, -cb*sa, ca*sg+sa*sb*cg],
    [sa*cg+ca*sb*sg, ca*cb, sa*sg-ca*sb*cg],
    [-cb*sg, sb, cb*cg]
  ];
}
export function orientationSample(alpha,beta,gamma,absolute=false,time=performance.now()) {
  const m=rotationMatrix(alpha,beta,gamma);
  const horizontalY=Math.hypot(m[0][1],m[1][1]);
  const heading=deg(Math.atan2(m[1][1],m[0][1]));
  const screenTilt=deg(Math.acos(clamp(m[2][2],-1,1)));
  // Device gravity from earth vertical, normalized to 1g; accelerometer down direction.
  const gravity={x:-m[2][0],y:-m[2][1],z:-m[2][2]};
  return {m,heading,horizontalY,screenTilt,gravity,q:quaternionFromMatrix(m),absolute,time};
}
export function quaternionFromMatrix(m){
  const tr=m[0][0]+m[1][1]+m[2][2];let w,x,y,z;
  if(tr>0){const s=Math.sqrt(tr+1)*2;w=s/4;x=(m[2][1]-m[1][2])/s;y=(m[0][2]-m[2][0])/s;z=(m[1][0]-m[0][1])/s;}
  else if(m[0][0]>m[1][1]&&m[0][0]>m[2][2]){const s=Math.sqrt(1+m[0][0]-m[1][1]-m[2][2])*2;w=(m[2][1]-m[1][2])/s;x=s/4;y=(m[0][1]+m[1][0])/s;z=(m[0][2]+m[2][0])/s;}
  else if(m[1][1]>m[2][2]){const s=Math.sqrt(1+m[1][1]-m[0][0]-m[2][2])*2;w=(m[0][2]-m[2][0])/s;x=(m[0][1]+m[1][0])/s;y=s/4;z=(m[1][2]+m[2][1])/s;}
  else{const s=Math.sqrt(1+m[2][2]-m[0][0]-m[1][1])*2;w=(m[1][0]-m[0][1])/s;x=(m[0][2]+m[2][0])/s;y=(m[1][2]+m[2][1])/s;z=s/4;}
  return quatNormalize({w,x,y,z});
}
export function quatNormalize(q){const n=Math.hypot(q.w,q.x,q.y,q.z);return {w:q.w/n,x:q.x/n,y:q.y/n,z:q.z/n};}
export function quatMultiply(a,b){return quatNormalize({w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z,x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w});}
export const quatInverse=q=>({w:q.w,x:-q.x,y:-q.y,z:-q.z});
export function matrixFromQuaternion(q){
  const {w,x,y,z}=q;
  return [
    [1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
    [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
    [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]
  ];
}
export function relativeRotation(zero,current){
  const q=quatMultiply(quatInverse(zero),current);
  const m=matrixFromQuaternion(q);
  // Relative-device Z-X-Y decomposition. Not anatomical flexion/abduction/rotation.
  const x=deg(Math.asin(clamp(m[2][1],-1,1)));
  const y=deg(Math.atan2(-m[2][0],m[2][2]));
  const z=deg(Math.atan2(-m[0][1],m[1][1]));
  const magnitude=deg(2*Math.acos(clamp(Math.abs(q.w),0,1)));
  return {x,y,z,magnitude};
}
export function gravityInclinometer(g,edge='long'){
  const value=edge==='long' ? deg(Math.atan2(-g.y,-g.z)) : deg(Math.atan2(-g.x,-g.z));
  // Component orthogonal to the intended gravity measurement plane.
  const outOfPlane=deg(Math.asin(clamp(Math.abs(edge==='long'?g.x:g.y),0,1)));
  return {angle:wrap180(value),outOfPlane};
}
export function circularMeanDegrees(angles){
  if(!angles.length)return null;
  const sin=angles.reduce((s,x)=>s+Math.sin(rad(x)),0);
  const cos=angles.reduce((s,x)=>s+Math.cos(rad(x)),0);
  return deg(Math.atan2(sin,cos));
}
export function circularSpreadDegrees(angles){
  const mean=circularMeanDegrees(angles);
  return mean===null ? Infinity : Math.max(...angles.map(x=>Math.abs(wrap180(x-mean))));
}
