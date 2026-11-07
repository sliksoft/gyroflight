/* From Betaflight src/main/common/maths.h:173: an int function, so a float argument is truncated. */
#pragma once
static inline int constrain(int amt, int low, int high)
{
    if (amt < low) return low;
    else if (amt > high) return high;
    else return amt;
}
