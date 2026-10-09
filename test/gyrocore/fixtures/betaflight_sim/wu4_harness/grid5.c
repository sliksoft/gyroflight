#define main sweep_main
#include "sweep.c"
#undef main
int main(void){ long tot=0,bad=0,badstrict=0; int shown=0;
 for(int m=50;m<=150;m+=5)for(int pi=50;pi<=150;pi+=5)for(int i=50;i<=150;i+=5)for(int d=50;d<=150;d+=5)for(int ff=50;ff<=150;ff+=5){
  sl_t s={m,100,i,d,pi,100,ff,100};
  for(int a=0;a<2;a++){ out_t x=v2(&s,a),z=v3(&s,a),y=v1(&s,a); tot++; if(memcmp(&x,&z,sizeof x)){bad++; if(shown<5){shown++;printf("arm!=app a=%d m=%d pi=%d i=%d d=%d ff=%d arm I=%d F=%d P=%d D=%d dm=%d app I=%d F=%d P=%d D=%d dm=%d\n",a,m,pi,i,d,ff,x.I,x.F,x.P,x.D,x.DM,z.I,z.F,z.P,z.D,z.DM);}} if(memcmp(&x,&y,sizeof x))badstrict++; }}
 printf("grid step5 50..150 (m,pi,i,d,ff; rpr=pp=dg=100), roll+pitch: total=%ld arm_vs_app_axis_mismatch=%ld (%.3f%%) arm_vs_strict=%ld\n",tot,bad,100.0*bad/tot,badstrict); }
