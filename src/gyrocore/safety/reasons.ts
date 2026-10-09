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

/*
 * Text for GyroCore Safety reason codes: `gyrocoreSafety_<code head>` with
 * the part after the first ":" as $1. Unknown codes are shown as they are.
 */

import { i18n } from "@/js/localization";

export function describeSafetyReason(code: string): string {
    const bare = code.startsWith("safety:") ? code.slice("safety:".length) : code;
    const colon = bare.indexOf(":");
    const head = colon >= 0 ? bare.slice(0, colon) : bare;
    const tail = colon >= 0 ? bare.slice(colon + 1) : "";
    const key = `gyrocoreSafety_${head}`;
    const text = i18n.getMessage(key, [tail]);
    return text && text !== key ? text : bare;
}
