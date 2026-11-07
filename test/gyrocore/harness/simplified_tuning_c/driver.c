/*
 * Prints what Betaflight's own applySimplifiedTuning() produces for each case, as JSON.
 * Inputs (one case per line on stdin, 13 slider values then the 8 LPF values):
 *   pids_mode master rp_ratio i d pi dmax ff pitch_pi dterm_on dterm_mult gyro_on gyro_mult
 *   dterm_lpf1_static dterm_lpf2_static dterm_dyn_min dterm_dyn_max
 *   gyro_lpf1_static gyro_lpf2_static gyro_dyn_min gyro_dyn_max
 * Starting PIDs are the AIR65's (56/79/30 F22, 82/117/61 F32, 56/79/0 F22, d_max 40/0/0).
 */
#include <stdio.h>
#include "config/simplified_tuning.h"

int main(void)
{
    int v[21];
    int first = 1;
    printf("[\n");
    while (1) {
        for (int k = 0; k < 21; k++) if (scanf("%d", &v[k]) != 1) goto done;
        pidProfile_t pp = { 0 };
        gyroConfig_t gc = { 0 };
        const int start[3][4] = { { 56, 79, 30, 22 }, { 82, 117, 61, 32 }, { 56, 79, 0, 22 } };
        const int dmax[3] = { 40, 0, 0 };
        for (int a = 0; a < 3; a++) {
            pp.pid[a].P = start[a][0]; pp.pid[a].I = start[a][1]; pp.pid[a].D = start[a][2]; pp.pid[a].F = start[a][3];
            pp.d_max[a] = dmax[a];
        }
        pp.simplified_pids_mode = v[0]; pp.simplified_master_multiplier = v[1]; pp.simplified_roll_pitch_ratio = v[2];
        pp.simplified_i_gain = v[3]; pp.simplified_d_gain = v[4]; pp.simplified_pi_gain = v[5];
        pp.simplified_d_max_gain = v[6]; pp.simplified_feedforward_gain = v[7]; pp.simplified_pitch_pi_gain = v[8];
        pp.simplified_dterm_filter = v[9]; pp.simplified_dterm_filter_multiplier = v[10];
        gc.simplified_gyro_filter = v[11]; gc.simplified_gyro_filter_multiplier = v[12];
        pp.dterm_lpf1_static_hz = v[13]; pp.dterm_lpf2_static_hz = v[14];
        pp.dterm_lpf1_dyn_min_hz = v[15]; pp.dterm_lpf1_dyn_max_hz = v[16];
        gc.gyro_lpf1_static_hz = v[17]; gc.gyro_lpf2_static_hz = v[18];
        gc.gyro_lpf1_dyn_min_hz = v[19]; gc.gyro_lpf1_dyn_max_hz = v[20];
        applySimplifiedTuning(&pp, &gc);
        printf("%s  {\"in\": [", first ? "" : ",\n");
        for (int k = 0; k < 21; k++) printf("%s%d", k ? ", " : "", v[k]);
        printf("], \"pids\": [[%d, %d, %d], [%d, %d, %d], [%d, %d, %d]], \"f\": [%d, %d, %d], \"dMax\": [%d, %d, %d], ",
            pp.pid[0].P, pp.pid[0].I, pp.pid[0].D, pp.pid[1].P, pp.pid[1].I, pp.pid[1].D, pp.pid[2].P, pp.pid[2].I, pp.pid[2].D,
            pp.pid[0].F, pp.pid[1].F, pp.pid[2].F, pp.d_max[0], pp.d_max[1], pp.d_max[2]);
        printf("\"dterm\": [%d, %d, %d, %d], \"gyro\": [%d, %d, %d, %d]}",
            pp.dterm_lpf1_static_hz, pp.dterm_lpf2_static_hz, pp.dterm_lpf1_dyn_min_hz, pp.dterm_lpf1_dyn_max_hz,
            gc.gyro_lpf1_static_hz, gc.gyro_lpf2_static_hz, gc.gyro_lpf1_dyn_min_hz, gc.gyro_lpf1_dyn_max_hz);
        first = 0;
    }
done:
    printf("\n]\n");
    return 0;
}
