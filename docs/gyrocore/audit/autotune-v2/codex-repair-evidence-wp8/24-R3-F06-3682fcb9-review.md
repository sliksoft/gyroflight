**P2 — The fieldset does not enforce the save lock in custom pointer handlers.**  
Anchor: `src/components/tabs/FailsafeTab.vue:6`, affecting the procedure selector at `:129` and other `USelect` controls.

The disabled state reaches the native fieldset, but never reaches the selectors’ `disabled` props. In the installed dependencies:

- `reka-ui/dist/Select/SelectTrigger.js:37–68` checks only component props before opening on **pointerdown**.
- `@nuxt/ui/dist/runtime/components/Select.vue:225` portals the menu outside the fieldset, into the app’s `#main-wrapper` portal (`src/App.vue:2`).
- `reka-ui/dist/Select/SelectItem.js:61–67` accepts selection based on the item’s own disabled prop, without checking the fieldset or save state.

**Reproduction scenario:** Start a changed Failsafe save on a slow connection. While it is pending, press the procedure selector in a browser that delivers pointer events to disabled form controls, such as Firefox. Its pointer handler can open the portaled menu despite native click suppression. Select another procedure before EEPROM completion/reboot. The store changes after the payload snapshot (`src/composables/failsafe/useFailsafeSave.ts:47–54`), so the selected procedure is not what the save persists. Reboot loses that edit—the round-2 defect remains reachable.

This is a **source-derived scenario, not an executed browser reproduction**.

**Would the new test catch it? No.** `test/components/FailsafeTab.test.ts:108–122` checks only the fieldset’s `disabled` property. Its `shallowMount` setup (`:26–32`) stubs the controls, so neither pointer handling nor portals execute. By inspection, removing the fieldset binding would fail the test; leaving the binding while retaining this bypass would pass. A real-control browser regression must attempt selection during saving and verify the model stays unchanged.

All configuration editors are lexically inside the fieldset. Ordinary native input/button interaction is covered by fieldset semantics, including the default button-based `USwitch`. However, `UInputNumber` increment/decrement also uses custom pointer handling and receives no save-disabled prop; it shares the missing component-level lock. `SettingRow` and `UiBox` preserve their editor slots; their help/collapse interactions do not themselves edit configuration.

Reviewed only `3682fcb9` and necessary surrounding source/tests at confirmed detached HEAD `e03cbc48`; those two changed files have no subsequent differences through HEAD. No additional race, hang, deadlock, false-success path, or write-authorization bypass was identified within this bounded change. No tests, browser, hardware, network, or agents were run. Tauri: **NOT_VALIDATED**.

The round-2 P2 is not fully closed; request changes despite finding no P0/P1 in this scope.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES