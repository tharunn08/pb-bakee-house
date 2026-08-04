'use strict';
/**
 * DELIVERY CHARGE ENGINE
 * ----------------------
 * Rule (as specified by the owner):
 *   • Base fare  ₹40  covers the first 2 km from the bakery.
 *   • Beyond 2 km, every additional kilometre (rounded UP) adds ₹10.
 *
 * Examples:
 *   1.4 km  ->  ₹40                       (within base radius)
 *   2.0 km  ->  ₹40                       (exactly at base radius)
 *   2.3 km  ->  ₹40 + ceil(0.3)*10 = ₹50
 *   4.0 km  ->  ₹40 + ceil(2.0)*10 = ₹60
 *   7.6 km  ->  ₹40 + ceil(5.6)*10 = ₹100
 */

// parseFloat tolerates a trailing N/E/S/W or spaces in the .env coordinates
// (e.g. "12.9377N") by stripping non-numeric trailing characters first.
const num = (v, d) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : d;
};

const cfg = () => ({
  lat:        num(process.env.BAKERY_LAT, 12.943563),
  lng:        num(process.env.BAKERY_LNG, 77.540188),
  baseFare:   num(process.env.DELIVERY_BASE_FARE, 40),
  baseKm:     num(process.env.DELIVERY_BASE_KM, 2),
  perExtraKm: num(process.env.DELIVERY_PER_EXTRA_KM, 10),
  maxKm:      num(process.env.DELIVERY_MAX_KM, 25),
  // Free delivery applies only when BOTH hold: subtotal >= freeAbove AND
  // distance <= freeWithinKm. Set FREE_DELIVERY_ABOVE=0 to disable entirely.
  freeAbove:  num(process.env.FREE_DELIVERY_ABOVE, 500),
  freeWithinKm: num(process.env.FREE_DELIVERY_WITHIN_KM, 2),
  prepMinutes:  num(process.env.DEFAULT_DELIVERY_MINUTES, 30),
});

/** Great-circle distance in km between two lat/lng points. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Road distance via Google Distance Matrix when an API key is configured,
 * otherwise straight-line distance with a small road-winding factor.
 */
async function distanceFromBakery(lat, lng) {
  const c = cfg();
  const key = (process.env.GOOGLE_MAPS_API_KEY || '').trim();

  if (key) {
    try {
      const url =
        'https://maps.googleapis.com/maps/api/distancematrix/json' +
        `?origins=${c.lat},${c.lng}&destinations=${lat},${lng}` +
        `&mode=driving&units=metric&key=${key}`;
      const res = await fetch(url);
      const data = await res.json();
      const el = data?.rows?.[0]?.elements?.[0];
      if (el?.status === 'OK' && el.distance?.value != null) {
        return { km: el.distance.value / 1000, source: 'google' };
      }
    } catch (err) {
      console.warn('Distance Matrix failed, falling back to haversine:', err.message);
    }
  }

  // Straight-line * 1.25 approximates typical road distance in Indian cities.
  const straight = haversineKm(c.lat, c.lng, lat, lng);
  return { km: straight * 1.25, source: 'haversine' };
}

/** Applies the fare rule to a distance in km. */
function fareForKm(km, orderSubtotal = 0) {
  const c = cfg();
  const distance = Math.round(km * 100) / 100;

  if (distance > c.maxKm) {
    return {
      distance_km: distance,
      delivery_charge: 0,
      deliverable: false,
      breakdown: `We currently deliver up to ${c.maxKm} km. Your location is ${distance} km away.`,
    };
  }

  // FREE delivery: order value >= threshold AND within the free radius (<= 2 km).
  const qualifiesFree =
    c.freeAbove > 0 && orderSubtotal >= c.freeAbove && distance <= c.freeWithinKm;
  if (qualifiesFree) {
    return {
      distance_km: distance,
      delivery_charge: 0,
      deliverable: true,
      is_free: true,
      base_fare: c.baseFare,
      base_km: c.baseKm,
      extra_km: 0,
      extra_charge: 0,
      eta_minutes: c.prepMinutes,
      breakdown: `FREE delivery — order above ₹${c.freeAbove} within ${c.freeWithinKm} km`,
    };
  }

  const extraKm = Math.max(0, distance - c.baseKm);
  const extraUnits = Math.ceil(extraKm);          // round UP to next km
  const extraCharge = extraUnits * c.perExtraKm;
  const total = c.baseFare + extraCharge;

  // How close the customer is to unlocking free delivery (shown at checkout).
  let free_hint = null;
  if (c.freeAbove > 0 && distance <= c.freeWithinKm && orderSubtotal < c.freeAbove) {
    free_hint = `Add ₹${Math.ceil(c.freeAbove - orderSubtotal)} more to get FREE delivery!`;
  }

  const breakdown = extraUnits === 0
    ? `Base ₹${c.baseFare} (up to ${c.baseKm} km)`
    : `Base ₹${c.baseFare} (up to ${c.baseKm} km) + ${extraUnits} km × ₹${c.perExtraKm} = ₹${extraCharge}`;

  return {
    distance_km: distance,
    delivery_charge: total,
    deliverable: true,
    is_free: false,
    base_fare: c.baseFare,
    base_km: c.baseKm,
    extra_km: extraUnits,
    extra_charge: extraCharge,
    eta_minutes: c.prepMinutes,
    free_hint,
    breakdown,
  };
}

/** One-shot: coordinates in, quote out. */
async function quote(lat, lng, orderSubtotal = 0) {
  const { km, source } = await distanceFromBakery(lat, lng);
  return { ...fareForKm(km, orderSubtotal), source };
}

module.exports = { haversineKm, distanceFromBakery, fareForKm, quote, cfg };
