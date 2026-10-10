/*
 * This file is part of Gyroflight, a derivative of the Betaflight App.
 *
 * Gyroflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Gyroflight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this software.
 *
 * If not, see <http://www.gnu.org/licenses/>.
 */

import GyroflightTab from "./tabs/GyroflightTab.vue";
import GyroflightHome from "./tabs/GyroflightHome.vue";
import "./branding/gyroflight-theme.css";
import { GYROFLIGHT_TAB_KEY } from "./tabs";
import { registerGyroflightMessages } from "./i18n";

registerGyroflightMessages();

export const gyroflightTabComponents = {
    [GYROFLIGHT_TAB_KEY]: GyroflightTab,
    // Gyroflight Home in place of Betaflight's Welcome tab. vue_tab_registry.js spreads these
    // entries after its own, so this key wins; LandingTab.vue itself is unchanged.
    landing: GyroflightHome,
};
