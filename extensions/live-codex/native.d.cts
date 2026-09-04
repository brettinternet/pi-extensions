import type {
  AudioCapture as AudioCaptureType,
  LiveWebRtcPeer as LiveWebRtcPeerType,
  deviceCheckGenerateToken as deviceCheckGenerateTokenType,
} from "@oh-my-pi/pi-natives";

export type AudioCapture = AudioCaptureType;
export type LiveWebRtcPeer = LiveWebRtcPeerType;

export const AudioCapture: typeof AudioCaptureType;
export const LiveWebRtcPeer: typeof LiveWebRtcPeerType;
export const deviceCheckGenerateToken: typeof deviceCheckGenerateTokenType;
