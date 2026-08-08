const DEFAULT_RADAR_RANGE_NM = 10;
const ALLOWED_RADAR_RANGES_NM = [5, 10, 20, 40];
const MAX_AIRCRAFT = 8;
const REFRESH_MS = 60 * 1000;

let radarRangeNm = DEFAULT_RADAR_RANGE_NM;
let refreshTimer = null;
let requestRunning = false;

// Manual location (optional). When set, the phone will use this instead of
// the device GPS. Persisted to localStorage as JSON {lat, lon}.
let manualLat = null;
let manualLon = null;

// Try to restore persisted manual location
try {
  const stored = localStorage.getItem("manual_location");
  if (stored) {
    const parsed = JSON.parse(stored);
    if (typeof parsed.lat === "number" && typeof parsed.lon === "number") {
      manualLat = parsed.lat;
      manualLon = parsed.lon;
      console.log("Restored manual location: " + manualLat + ", " + manualLon);
    }
  }
} catch (err) {
  console.log("Could not read stored manual location: " + err);
}

function degreesToRadians(degrees) {
  return degrees * Math.PI / 180;
}

function radiansToDegrees(radians) {
  return radians * 180 / Math.PI;
}

function normalizeBearing(degrees) {
  return (degrees + 360) % 360;
}

function calculateDistanceNm(lat1, lon1, lat2, lon2) {
  const earthRadiusNm = 3440.065;
  const latitude1 = degreesToRadians(lat1);
  const latitude2 = degreesToRadians(lat2);
  const deltaLatitude = degreesToRadians(lat2 - lat1);
  const deltaLongitude = degreesToRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(latitude1) * Math.cos(latitude2) *
    Math.sin(deltaLongitude / 2) * Math.sin(deltaLongitude / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusNm * c;
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const latitude1 = degreesToRadians(lat1);
  const latitude2 = degreesToRadians(lat2);
  const deltaLongitude = degreesToRadians(lon2 - lon1);
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x =
    Math.cos(latitude1) * Math.sin(latitude2) -
    Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);
  return normalizeBearing(radiansToDegrees(Math.atan2(y, x)));
}

function getCallsign(rawAircraft) {
  if (typeof rawAircraft.flight === "string" && rawAircraft.flight.trim().length > 0) {
    return rawAircraft.flight.trim();
  }
  if (typeof rawAircraft.r === "string" && rawAircraft.r.trim().length > 0) {
    return rawAircraft.r.trim();
  }
  if (typeof rawAircraft.hex === "string") {
    return rawAircraft.hex.toUpperCase();
  }
  return "UNKNOWN";
}

function getAltitude(rawAircraft) {
  if (typeof rawAircraft.alt_baro === "number") {
    return Math.round(rawAircraft.alt_baro);
  }
  if (typeof rawAircraft.alt_geom === "number") {
    return Math.round(rawAircraft.alt_geom);
  }
  return 0;
}

function processAircraft(rawList, userLat, userLon) {
  if (!Array.isArray(rawList)) {
    return [];
  }

  const results = [];

  rawList.forEach(function(rawAircraft) {
    if (typeof rawAircraft.lat !== "number" || typeof rawAircraft.lon !== "number") {
      return;
    }

    const distanceNm = calculateDistanceNm(
      userLat,
      userLon,
      rawAircraft.lat,
      rawAircraft.lon
    );

    if (distanceNm > radarRangeNm) {
      return;
    }

    results.push({
      callsign: getCallsign(rawAircraft),
      distanceTenths: Math.round(distanceNm * 10),
      bearing: Math.round(
        calculateBearing(userLat, userLon, rawAircraft.lat, rawAircraft.lon)
      ),
      track: typeof rawAircraft.track === "number" ? Math.round(rawAircraft.track) : 0,
      altitude: getAltitude(rawAircraft)
    });
  });

  results.sort(function(first, second) {
    return first.distanceTenths - second.distanceTenths;
  });

  return results.slice(0, MAX_AIRCRAFT);
}

function serializeAircraft(aircraft) {
  return aircraft.map(function(item) {
    return [
      item.callsign,
      item.distanceTenths,
      item.bearing,
      item.track,
      item.altitude
    ].join(",");
  }).join(";");
}

function sendStatus(status, aircraftText) {
  const payload = {
    STATUS: status,
    RADAR_RANGE: radarRangeNm
  };

  if (aircraftText !== undefined) {
    payload.AIRCRAFT = aircraftText;
  }

  Pebble.sendAppMessage(
    payload,
    function() {
      console.log("Sent update to watch: " + status);
    },
    function(error) {
      console.log("Could not send update: " + JSON.stringify(error));
    }
  );
}

function fetchAircraft(latitude, longitude) {
  const url =
    "https://opendata.adsb.fi/api/v3/lat/" + latitude +
    "/lon/" + longitude +
    "/dist/" + radarRangeNm;

  console.log("Requesting: " + url);
  const request = new XMLHttpRequest();
  request.open("GET", url, true);

  request.onload = function() {
    requestRunning = false;

    if (request.status < 200 || request.status >= 300) {
      console.log("ADS-B HTTP error: " + request.status);
      sendStatus("HTTP " + request.status);
      return;
    }

    try {
      const response = JSON.parse(request.responseText);
      const aircraft = processAircraft(response.ac, latitude, longitude);
      const compactAircraft = serializeAircraft(aircraft);
      console.log("Aircraft returned: " + aircraft.length);
      console.log("Compact payload bytes: " + compactAircraft.length);
      sendStatus("LIVE", compactAircraft);
    } catch (error) {
      console.log("JSON processing error: " + error);
      sendStatus("DATA ERROR");
    }
  };

  request.onerror = function() {
    requestRunning = false;
    console.log("ADS-B network request failed");
    sendStatus("NETWORK ERROR");
  };

  request.send();
}

function updateRadar() {
  if (requestRunning) {
    console.log("Update already running");
    return;
  }

  requestRunning = true;
  sendStatus("GETTING GPS");

  // If manual location is configured, use it instead of device GPS.
  if (typeof manualLat === "number" && typeof manualLon === "number") {
    console.log("Using manual location: " + manualLat + ", " + manualLon);
    sendStatus("LOADING ADS-B");
    fetchAircraft(manualLat, manualLon);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function(position) {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;

      console.log("Location: " + latitude + ", " + longitude);
      sendStatus("LOADING ADS-B");
      fetchAircraft(latitude, longitude);
    },
    function(error) {
      requestRunning = false;
      console.log("Location error " + error.code + ": " + error.message);
      sendStatus("GPS ERROR");
    },
    {
      enableHighAccuracy: false,
      maximumAge: 60000,
      timeout: 10000
    }
  );
}

Pebble.addEventListener("appmessage", function(event) {
  // Handle radar range changes as before
  if (event.payload && event.payload.RADAR_RANGE !== undefined) {
    const requestedRange = Number(event.payload.RADAR_RANGE);

    if (ALLOWED_RADAR_RANGES_NM.indexOf(requestedRange) < 0) {
      return;
    }

    if (requestedRange === radarRangeNm) {
      return;
    }

    radarRangeNm = requestedRange;
    requestRunning = false;
    console.log("Watch requested " + radarRangeNm + " NM range");
    updateRadar();
    return;
  }

  // Manual location support: MANUAL_LAT, MANUAL_LON, MANUAL_CLEAR
  if (event.payload) {
    if (event.payload.MANUAL_CLEAR) {
      manualLat = null;
      manualLon = null;
      try {
        localStorage.removeItem("manual_location");
      } catch (err) {
        console.log("Could not clear stored manual location: " + err);
      }
      requestRunning = false;
      console.log("Manual location cleared");
      sendStatus("MANUAL CLEARED");
      updateRadar();
      return;
    }

    const lat = event.payload.MANUAL_LAT !== undefined ? Number(event.payload.MANUAL_LAT) : NaN;
    const lon = event.payload.MANUAL_LON !== undefined ? Number(event.payload.MANUAL_LON) : NaN;

    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      manualLat = lat;
      manualLon = lon;
      try {
        localStorage.setItem("manual_location", JSON.stringify({ lat: manualLat, lon: manualLon }));
      } catch (err) {
        console.log("Could not persist manual location: " + err);
      }

      requestRunning = false;
      console.log("Manual location set: " + manualLat + ", " + manualLon);
      sendStatus("MANUAL SET");
      updateRadar();
      return;
    }
  }
});

Pebble.addEventListener("ready", function() {
  console.log("ADS-B PKJS ready");
  updateRadar();

  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = setInterval(updateRadar, REFRESH_MS);
});
