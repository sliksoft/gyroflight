/* Verbatim formulas from betaflight@4fc1520c src/main/config/simplified_tuning.c:31-63, constants pid.h:42-71 */
#include <stdint.h>
#define PID_GAIN_MAX 250
#define F_GAIN_MAX 1000
#define FD_ROLL 0
#define FD_PITCH 1
#define FLIGHT_DYNAMICS_INDEX_COUNT 3
#define PID_ROLL 0
#define PID_PITCH 1
#define PID_YAW 2
#define PID_ROLL_DEFAULT  { 45, 80, 30, 120, 0 }
#define PID_PITCH_DEFAULT { 47, 84, 34, 125, 0 }
#define PID_YAW_DEFAULT   { 45, 80,  0, 120, 0 }
#define D_MAX_DEFAULT     { 40, 46, 0 }
#define USE_D_MAX
typedef struct pidf_s { uint8_t P; uint8_t I; uint8_t D; uint16_t F; uint8_t S; } pidf_t;
typedef struct { pidf_t pid[5]; uint8_t d_max[3];
 uint8_t simplified_pids_mode, simplified_master_multiplier, simplified_roll_pitch_ratio, simplified_i_gain,
 simplified_d_gain, simplified_pi_gain, simplified_d_max_gain, simplified_feedforward_gain, simplified_pitch_pi_gain; } pidProfile_t;
static inline int constrain(int amt, int low, int high)
{ if (amt < low) return low; else if (amt > high) return high; else return amt; }
void calculateNewPidValues(pidProfile_t *pidProfile)
{
    const pidf_t pidDefaults[FLIGHT_DYNAMICS_INDEX_COUNT] = {
            [PID_ROLL] = PID_ROLL_DEFAULT,
            [PID_PITCH] = PID_PITCH_DEFAULT,
            [PID_YAW] = PID_YAW_DEFAULT,
        };
#ifdef USE_D_MAX
    const int dMaxDefaults[FLIGHT_DYNAMICS_INDEX_COUNT] = D_MAX_DEFAULT;
#endif
    const float masterMultiplier = pidProfile->simplified_master_multiplier / 100.0f;
    const float piGain = pidProfile->simplified_pi_gain / 100.0f;
    const float dGain = pidProfile->simplified_d_gain / 100.0f;
    const float feedforwardGain = pidProfile->simplified_feedforward_gain / 100.0f;
    const float iGain = pidProfile->simplified_i_gain / 100.0f;

    for (int axis = FD_ROLL; axis <= pidProfile->simplified_pids_mode; ++axis) {
        const float pitchDGain = (axis == FD_PITCH) ? pidProfile->simplified_roll_pitch_ratio / 100.0f : 1.0f;
        const float pitchPiGain = (axis == FD_PITCH) ? pidProfile->simplified_pitch_pi_gain / 100.0f : 1.0f;
        pidProfile->pid[axis].P = constrain(pidDefaults[axis].P * masterMultiplier * piGain * pitchPiGain, 0, PID_GAIN_MAX);
        pidProfile->pid[axis].I = constrain(pidDefaults[axis].I * masterMultiplier * piGain * iGain * pitchPiGain, 0, PID_GAIN_MAX);
        pidProfile->pid[axis].D = constrain(pidDefaults[axis].D * masterMultiplier * dGain * pitchDGain, 0, PID_GAIN_MAX);
        pidProfile->pid[axis].F = constrain(pidDefaults[axis].F * masterMultiplier * pitchPiGain * feedforwardGain, 0, F_GAIN_MAX);

#ifdef USE_D_MAX
        const float dMaxGain = (dMaxDefaults[axis] > 0)
            ? pidProfile->simplified_d_max_gain / 100.0f + (1 - pidProfile->simplified_d_max_gain / 100.0f) * pidDefaults[axis].D / dMaxDefaults[axis]
            : 1.0f;
        pidProfile->d_max[axis] = constrain(dMaxDefaults[axis] * masterMultiplier * dGain * pitchDGain * dMaxGain, 0, PID_GAIN_MAX);
#endif
    }
}
