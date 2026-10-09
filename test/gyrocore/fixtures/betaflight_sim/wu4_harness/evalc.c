#define main sweep_main
#include "sweep.c"
#undef main
int main(void){ int mode; sl_t s;
 while(scanf("%d %d %d %d %d %d %d %d %d",&mode,&s.m,&s.rpr,&s.i,&s.d,&s.pi,&s.dg,&s.ff,&s.pp)==9){
  for(int a=0;a<3;a++){ out_t x=v1(&s,a),y=v2(&s,a),z=v3(&s,a); printf("%d %d %d %d %d  %d %d %d %d %d  %d %d %d %d %d%s",x.P,x.I,x.D,x.F,x.DM,y.P,y.I,y.D,y.F,y.DM,z.P,z.I,z.D,z.F,z.DM,a<2?" | ":"\n"); } fflush(stdout);} }
