#define main sweep_main
#include "sweep.c"
#undef main
typedef struct { const char*name; int mode; sl_t s; } cfg_t;
static void pr(const char*k,out_t o,int last){ printf("\"%s\":{\"P\":%d,\"I\":%d,\"D\":%d,\"F\":%d,\"d_max\":%d}%s",k,o.P,o.I,o.D,o.F,o.DM,last?"":","); }
int main(void){
  /* sl_t order: m,rpr,i,d,pi,dg,ff,pp */
  cfg_t C[]={
   {"defaults_all_100_RPY",2,{100,100,100,100,100,100,100,100}},
   {"pi138_ff138",2,{100,100,100,100,138,100,138,100}},
   {"master50",2,{50,100,100,100,100,100,100,100}},
   {"master200",2,{200,100,100,100,100,100,100,100}},
   {"d150",2,{100,100,100,150,100,100,100,100}},
   {"i150",2,{100,100,150,100,100,100,100,100}},
   {"pitch_rpr120_pp110",2,{100,120,100,100,100,100,100,110}},
   {"pitch_rpr80_pp90",2,{100,80,100,100,100,100,100,90}},
   {"dmax_gain0",2,{100,100,100,100,100,0,100,100}},
   {"dmax_gain200",2,{100,100,100,100,100,200,100,100}},
   {"ff0",2,{100,100,100,100,100,100,0,100}},
   {"master110",2,{110,100,100,100,100,100,100,100}},
   {"master125_pi125_i80_d110_ff90_dg50",2,{125,100,80,110,125,50,90,100}},
   {"all200",2,{200,200,200,200,200,200,200,200}},
   {"RP_mode_master150",1,{150,100,100,100,100,100,100,100}},
   {"OFF_mode_master150",0,{150,100,100,100,100,100,100,100}},
   {"pi250_outside_cli_range_msp_only",2,{100,100,100,100,250,100,100,100}},
  };
  int n=sizeof C/sizeof C[0];
  printf("{\"firmware\":{\"repo\":\"https://github.com/betaflight/betaflight\",\"sha\":\"4fc1520c5a5decddc8ef07ad57c0e766ea8747ba\",\"file\":\"src/main/config/simplified_tuning.c\"},\n");
  printf("\"variants\":{\"fw_arm\":\"GROUND TRUTH: float32 op sequence of arm-none-eabi-gcc 13.2.1 -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard -Os -ffast-math (+LTO link -Ofast keeps it), emulated on x86 with fmaf\",\"fw_strict\":\"verbatim C, strict IEEE float32 x86-64 gcc -O2 -fno-fast-math -ffp-contract=off\",\"app_ts\":\"Gyroflight src/js/simplifiedTuning.ts (double), C replica; cross-checked with node on the real TS code\"},\n");
  printf("\"note_mode\":\"axes 0..simplified_pids_mode are recomputed; RP(1) leaves yaw PIDs/FF/d_max unchanged (yaw shown as null); OFF(0) recomputes nothing\",\n\"pid_configs\":[\n");
  for(int k=0;k<n;k++){
    sl_t*s=&C[k].s;
    printf("{\"name\":\"%s\",\"sliders\":{\"simplified_pids_mode\":%d,\"simplified_master_multiplier\":%d,\"simplified_pi_gain\":%d,\"simplified_i_gain\":%d,\"simplified_d_gain\":%d,\"simplified_feedforward_gain\":%d,\"simplified_d_max_gain\":%d,\"simplified_pitch_d_gain(roll_pitch_ratio)\":%d,\"simplified_pitch_pi_gain\":%d},\"axes\":{",C[k].name,C[k].mode,s->m,s->pi,s->i,s->d,s->ff,s->dg,s->rpr,s->pp);
    const char*an[3]={"roll","pitch","yaw"};
    for(int a=0;a<3;a++){
      if(C[k].mode==0 || a>C[k].mode){ printf("\"%s\":null%s",an[a],a<2?",":""); continue; }
      out_t x=v2(s,a),y=v1(s,a),z=v3(s,a);
      printf("\"%s\":{",an[a]); pr("fw_arm",x,0); pr("fw_strict",y,0); pr("app_ts",z,1);
      int agree = !memcmp(&x,&y,sizeof x) && !memcmp(&x,&z,sizeof x);
      printf(",\"all_agree\":%s}%s",agree?"true":"false",a<2?",":"");
    }
    printf("}}%s\n",k<n-1?",":"");
  }
  printf("],\n\"filter_configs\":[\n");
  int mults[]={0,1,5,10,25,50,75,90,100,110,120,138,150,175,200,250,255}; int nm=sizeof mults/sizeof mults[0];
  for(int k=0;k<nm;k++){ int m=mults[k];
    printf("{\"multiplier\":%d,\"cli_legal\":%s,\"dterm\":{\"lpf1_dyn_min_hz\":%d,\"lpf1_dyn_max_hz\":%d,\"lpf1_static_hz\":%d,\"lpf2_static_hz\":%d},\"gyro\":{\"lpf1_dyn_min_hz\":%d,\"lpf1_dyn_max_hz\":%d,\"lpf1_static_hz\":%d,\"lpf2_static_hz\":%d}}%s\n",
      m,(m>=10&&m<=200)?"true":"false",
      constrain(75*m/100,0,1000),constrain(150*m/100,0,1000),constrain(75*m/100,0,1000),constrain(150*m/100,0,1000),
      constrain(250*m/100,0,1000),constrain(500*m/100,0,1000),constrain(250*m/100,0,1000),constrain(500*m/100,0,1000),k<nm-1?",":""); }
  printf("],\n\"exhaustive_sweep_0_200\":\"see h/sweep_0_200.txt; counts of slider combos where integer results differ\",\n\"filter_note\":\"each value is written only if that field was nonzero before apply (and simplified_*_filter on); dyn min nonzero gates both dyn min and dyn max; integer arithmetic DEFAULT*mult/100 (C int division)\"\n}\n");
  return 0;
}
