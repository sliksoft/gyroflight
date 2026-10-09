#include <stdint.h>
#include <string.h>
typedef struct pidf_s { uint8_t P; uint8_t I; uint8_t D; uint16_t F; uint8_t S; } pidf_t;
typedef struct { pidf_t pid[5]; uint8_t d_max[3];
 uint8_t simplified_pids_mode, simplified_master_multiplier, simplified_roll_pitch_ratio, simplified_i_gain,
 simplified_d_gain, simplified_pi_gain, simplified_d_max_gain, simplified_feedforward_gain, simplified_pitch_pi_gain; } pidProfile_t;
void applySimplifiedTuningPids(pidProfile_t *pidProfile);
volatile pidProfile_t g; volatile uint8_t out[64];
int main(void){ pidProfile_t t; memcpy(&t,(const void*)&g,sizeof t); applySimplifiedTuningPids(&t); memcpy((void*)out,&t,sizeof t); return 0; }
