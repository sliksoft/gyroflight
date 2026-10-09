/* Three implementations of betaflight@4fc1520c simplified_tuning.c calculateNewPidValues:
 *  V1 strict: verbatim C source, IEEE float32, no fast-math, no contraction (x86-64 SSE).
 *  V2 arm:    float32 op sequence emitted by arm-none-eabi-gcc 13.2.1 -mcpu=cortex-m4 -Os -ffast-math
 *             (identical under the Betaflight-style LTO link, see lto_calc.dis): x/100.0f -> x*0x3c23d70a,
 *             reassociated products, vfms/vfma fused in dMaxGain, vcvt.s32.f32 truncation.
 *  V3 app:    Gyroflight src/js/simplifiedTuning.ts in IEEE double (JS Number), Math.trunc then clamp.
 */
#include <stdio.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
static const int PD[3][4] = {{45,80,30,120},{47,84,34,125},{45,80,0,120}};
static const int DMD[3] = {40,46,0};
static inline int constrain(int a,int lo,int hi){ return a<lo?lo:(a>hi?hi:a); }
typedef struct { int P,I,D,F,DM; } out_t;
typedef struct { int m,rpr,i,d,pi,dg,ff,pp; } sl_t;

static out_t v1(const sl_t*s,int axis){ /* verbatim */
  const float masterMultiplier = s->m / 100.0f, piGain = s->pi/100.0f, dGain = s->d/100.0f,
    feedforwardGain = s->ff/100.0f, iGain = s->i/100.0f;
  const float pitchDGain = (axis==1) ? s->rpr/100.0f : 1.0f;
  const float pitchPiGain = (axis==1) ? s->pp/100.0f : 1.0f;
  out_t o;
  o.P = constrain(PD[axis][0]*masterMultiplier*piGain*pitchPiGain,0,250);
  o.I = constrain(PD[axis][1]*masterMultiplier*piGain*iGain*pitchPiGain,0,250);
  o.D = constrain(PD[axis][2]*masterMultiplier*dGain*pitchDGain,0,250);
  o.F = constrain(PD[axis][3]*masterMultiplier*pitchPiGain*feedforwardGain,0,1000);
  const float dMaxGain = (DMD[axis]>0) ? s->dg/100.0f + (1 - s->dg/100.0f)*PD[axis][2]/DMD[axis] : 1.0f;
  o.DM = constrain(DMD[axis]*masterMultiplier*dGain*pitchDGain*dMaxGain,0,250);
  return o;
}
static inline int cvt(float x){ return (int)x; } /* vcvt.s32.f32 = round toward zero */
static out_t v2(const sl_t*s,int axis){
  float c; uint32_t u=0x3c23d70a; memcpy(&c,&u,4);
  float M=(float)s->m*c;
  float PM=((float)s->pi*c)*M;
  float IPM=((float)s->i*c)*PM;
  float DM=((float)s->d*c)*M;
  float FM=((float)s->ff*c)*M;
  float pPi = axis==1 ? (float)s->pp*c : 1.0f;
  float pD  = axis==1 ? (float)s->rpr*c : 1.0f;
  out_t o;
  o.P=constrain(cvt(((float)PD[axis][0]*PM)*pPi),0,250);
  o.I=constrain(cvt(((float)PD[axis][1]*IPM)*pPi),0,250);
  float Dd=(float)PD[axis][2];
  o.D=constrain(cvt((Dd*DM)*pD),0,250);
  o.F=constrain(cvt(((float)PD[axis][3]*FM)*pPi),0,1000);
  float def=(float)DMD[axis], gain;
  if (DMD[axis]>0){ float g=(float)s->dg; float t=fmaf(-g,c,1.0f); float s7=Dd*t; float q=s7/def; gain=fmaf(g,c,q);} else gain=1.0f;
  o.DM=constrain(cvt(((DM*def)*pD)*gain),0,250);
  return o;
}
static inline int jtrunc(double x){ return (int)trunc(x); }
static inline int jclamp(double x,int lo,int hi){ double t=trunc(x); return (int)fmin(hi,fmax(lo,t)); }
static out_t v3(const sl_t*s,int axis){
  double M=s->m/100.0, R=s->rpr/100.0, I=s->i/100.0, D=s->d/100.0, PI=s->pi/100.0, G=s->dg/100.0, FF=s->ff/100.0, PP=s->pp/100.0;
  double pD = axis==1?R:1, pPi = axis==1?PP:1;
  out_t o;
  o.P=jclamp(PD[axis][0]*M*PI*pPi,0,250);
  o.I=jclamp(PD[axis][1]*M*PI*I*pPi,0,250);
  o.D=jclamp(PD[axis][2]*M*D*pD,0,250);
  o.F=jclamp(PD[axis][3]*M*pPi*FF,0,1000);
  o.DM=0;
  if (DMD[axis]>0){ double sc=G+(1-G)*((double)PD[axis][2]/DMD[axis]); o.DM=jclamp(DMD[axis]*M*D*pD*sc,0,250);} 
  return o;
}
/* mismatch bookkeeping */
typedef struct { long long n12,n13,n23,tot; int ex12,ex13,ex23; } cnt_t;
static void cmp(cnt_t*c,const char*term,int axis,const sl_t*s,int a,int b,int k,int which){
  (void)k;
  if(a==b) return;
  long long*n = which==12?&c->n12:which==13?&c->n13:&c->n23;
  int*ex = which==12?&c->ex12:which==13?&c->ex13:&c->ex23;
  (*n)++;
  if(*ex<6){ (*ex)++; printf("  EX V%d %s axis=%d m=%d pi=%d i=%d d=%d ff=%d dg=%d rpr=%d pp=%d : %d vs %d\n",which,term,axis,s->m,s->pi,s->i,s->d,s->ff,s->dg,s->rpr,s->pp,a,b);} }
int main(int argc,char**argv){
  int MAXV = argc>1?atoi(argv[1]):200;
  const char* names[5]={"P","I","D","F","dmax"};
  for(int axis=0;axis<3;axis++) for(int term=0;term<5;term++){
    if(axis==2 && (term==2||term==4)) continue; /* yaw D, dmax defaults 0 */
    cnt_t c={0};
    sl_t s={100,100,100,100,100,100,100,100};
    /* enumerate only sliders the term depends on */
    int *vars[4]; int nv=0;
    vars[nv++]=&s.m;
    if(term==0){ vars[nv++]=&s.pi; if(axis==1) vars[nv++]=&s.pp; }
    if(term==1){ vars[nv++]=&s.pi; vars[nv++]=&s.i; if(axis==1) vars[nv++]=&s.pp; }
    if(term==2){ vars[nv++]=&s.d; if(axis==1) vars[nv++]=&s.rpr; }
    if(term==3){ vars[nv++]=&s.ff; if(axis==1) vars[nv++]=&s.pp; }
    if(term==4){ vars[nv++]=&s.d; vars[nv++]=&s.dg; if(axis==1) vars[nv++]=&s.rpr; }
    int idx[4]={0,0,0,0};
    printf("axis=%d term=%s sliders=%d range=0..%d\n",axis,names[term],nv,MAXV);
    for(;;){
      for(int k=0;k<nv;k++) *vars[k]=idx[k];
      out_t a=v1(&s,axis), b=v2(&s,axis), d=v3(&s,axis);
      int va[5]={a.P,a.I,a.D,a.F,a.DM}, vb[5]={b.P,b.I,b.D,b.F,b.DM}, vd[5]={d.P,d.I,d.D,d.F,d.DM};
      c.tot++;
      cmp(&c,names[term],axis,&s,va[term],vb[term],term,12);
      cmp(&c,names[term],axis,&s,va[term],vd[term],term,13);
      cmp(&c,names[term],axis,&s,vb[term],vd[term],term,23);
      int k=0; while(k<nv && ++idx[k]>MAXV){ idx[k]=0; k++; } if(k==nv) break;
    }
    printf("  RESULT axis=%d %s total=%lld strict_vs_arm=%lld strict_vs_app=%lld arm_vs_app=%lld\n",axis,names[term],c.tot,c.n12,c.n13,c.n23);
  }
  /* filters: integer firmware vs app double */
  int defs[6]={75,150,150,250,500,500}; long long fm=0;
  for(int m=0;m<=255;m++) for(int k=0;k<6;k++){ int fw=constrain(defs[k]*m/100,0,1000); int app=jclamp((double)defs[k]*m/100.0,0,1000); if(fw!=app){fm++;} }
  printf("FILTER firmware_int_vs_app_double mismatches over mult 0..255: %lld\n",fm);
  return 0;
}
