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

// Gyroflight divergences from upstream Betaflight behaviour. Every upstream file
// that checks one of these flags imports it from here, so `git grep gyroflight/policy`
// lists every gated site. See docs/gyrocore/UPSTREAM.md ("Privacy and accounts").

/**
 * Betaflight's usage analytics (src/js/Analytics.ts) post to analytics.betaflight.com.
 * Gyroflight sends no usage data anywhere, so Analytics.send() is a no-op.
 */
export const UPSTREAM_ANALYTICS_ENABLED = false;

/**
 * Betaflight accounts (login, passkeys, cloud backups, user profile) are bound to
 * Betaflight's own origin (WebAuthn relying party, CORS) and cannot work from
 * Gyroflight's origin, so their UI entry points are hidden.
 */
export const BETAFLIGHT_ACCOUNTS_ENABLED = false;


/**
 * Gyroflight keeps Betaflight's theme mechanism, but uses the GyroCore cyan
 * palette as the product default.
 */
export const GYROFLIGHT_COLOR_THEME = "gyroflight";
