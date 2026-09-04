"use strict";

const bindings = require(
  `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`,
);

exports.AudioCapture = bindings.AudioCapture;
exports.LiveWebRtcPeer = bindings.LiveWebRtcPeer;
exports.deviceCheckGenerateToken = bindings.deviceCheckGenerateToken;
