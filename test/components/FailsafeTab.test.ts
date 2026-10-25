import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import FailsafeTab from "../../src/components/tabs/FailsafeTab.vue";
import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { useFlightControllerStore } from "../../src/stores/fc";

const saveAndReboot = vi.fn();

vi.mock("../../src/js/msp", () => ({ default: { promise: vi.fn() } }));
vi.mock("../../src/js/msp/MSPHelper", async () => {
    const { default: MSP } = await import("../../src/js/msp");
    return {
        mspHelper: { crunch: () => [], sendRxFailConfig: (callback: () => void) => callback() },
        // An acknowledged write is the (mocked) MSP.promise resolving.
        confirmedWrite: async (code: number, data: number[]) => {
            await MSP.promise(code, data);
        },
    };
});
vi.mock("../../src/composables/useReboot", () => ({ useReboot: () => ({ saveAndReboot }) }));
vi.mock("../../src/js/localization", () => ({ i18n: { getMessage: (key: string) => key } }));

function mountTab() {
    return shallowMount(FailsafeTab, {
        global: {
            renderStubDefaultSlot: true,
            mocks: { $t: (key: string) => key },
        },
    });
}

describe("Failsafe MSP wiring", () => {
    let wrapper: ReturnType<typeof mountTab>;

    beforeEach(() => {
        vi.resetAllMocks();
        setActivePinia(createPinia());
        useFlightControllerStore().config.apiVersion = "1.47.0";
        vi.mocked(MSP.promise).mockResolvedValue(undefined);
        // The firmware acknowledged the EEPROM save: onSaved runs (audit WP8-F06).
        saveAndReboot.mockImplementation(async ({ onSaved }: { onSaved?: () => void } = {}) => onSaved?.());
    });

    afterEach(() => {
        wrapper.unmount();
    });

    it("loads the configuration on mount, then takes it as the clean baseline", async () => {
        wrapper = mountTab();
        await flushPromises();

        expect(vi.mocked(MSP.promise).mock.calls[0]).toEqual([MSPCodes.MSP_RX_CONFIG]);
        expect(vi.mocked(MSP.promise).mock.calls.at(-1)).toEqual([MSPCodes.MSP_MODE_RANGES]);
        expect((wrapper.vm as unknown as { configHasChanged: boolean }).configHasChanged).toBe(false);
    });

    it("resets the dirty baseline when the save goes through", async () => {
        wrapper = mountTab();
        await flushPromises();
        const fcStore = useFlightControllerStore();
        const vm = wrapper.vm as unknown as { configHasChanged: boolean; saveConfig: () => Promise<void> };

        fcStore.failsafeConfig.failsafe_delay += 1;
        await nextTick();
        expect(vm.configHasChanged).toBe(true);

        await vm.saveConfig();
        await nextTick();

        expect(saveAndReboot).toHaveBeenCalledOnce();
        expect(vm.configHasChanged).toBe(false);
    });

    // Codex review of F06: an edit made while the save runs was never sent; it stays pending.
    it("keeps an edit made during the save pending after the save is confirmed", async () => {
        let finish!: () => void;
        saveAndReboot.mockImplementation(
            ({ onSaved }: { onSaved?: () => void } = {}) =>
                new Promise<void>((resolve) => {
                    finish = () => {
                        onSaved?.();
                        resolve();
                    };
                }),
        );
        wrapper = mountTab();
        await flushPromises();
        const fcStore = useFlightControllerStore();
        const vm = wrapper.vm as unknown as { configHasChanged: boolean; saveConfig: () => Promise<void> };

        fcStore.failsafeConfig.failsafe_delay += 1;
        await nextTick();
        const saving = vm.saveConfig();
        await flushPromises();
        fcStore.failsafeConfig.failsafe_delay += 1; // after the values were taken for this save
        await nextTick();
        finish();
        await saving;
        await nextTick();

        expect(vm.configHasChanged).toBe(true);
    });

    // Gyroflight (audit WP8-F06): the RAM may hold the values, EEPROM does not; Save stays enabled.
    it("keeps the changes pending when the EEPROM save is not confirmed", async () => {
        saveAndReboot.mockRejectedValue(new Error("EEPROM save not confirmed (unknown)"));
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        wrapper = mountTab();
        await flushPromises();
        const fcStore = useFlightControllerStore();
        const vm = wrapper.vm as unknown as { configHasChanged: boolean; saveConfig: () => Promise<void> };

        fcStore.failsafeConfig.failsafe_delay += 1;
        await nextTick();
        await vm.saveConfig();
        await nextTick();

        expect(saveAndReboot).toHaveBeenCalledOnce();
        expect(vm.configHasChanged).toBe(true);
    });
});
