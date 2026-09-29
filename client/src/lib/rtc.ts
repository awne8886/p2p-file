import type { IceCandidatePayload, IceServerConfig, SignalPayload } from '@pizzadrop/shared';

/**
 * Thin wrapper around RTCPeerConnection that speaks our {@link SignalPayload}
 * format and queues remote ICE candidates that arrive before the remote
 * description (which happens routinely with trickle ICE).
 */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private closed = false;

  constructor(
    iceServers: IceServerConfig[],
    private readonly sendSignal: (data: SignalPayload) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignal({ kind: 'candidate', candidate: serializeCandidate(ev.candidate) });
    };
  }

  /** Sender side: create the offer. Call after creating the data channel. */
  async offer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ kind: 'description', description: { type: 'offer', sdp: offer.sdp ?? '' } });
  }

  async handleSignal(data: SignalPayload): Promise<void> {
    if (this.closed) return;
    if (data.kind === 'description') {
      await this.pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal({ kind: 'description', description: { type: 'answer', sdp: answer.sdp ?? '' } });
      }
      const queued = this.pendingCandidates;
      this.pendingCandidates = [];
      for (const c of queued) await this.addCandidate(c);
      return;
    }
    if (!data.candidate) return;
    const init: RTCIceCandidateInit = {
      candidate: data.candidate.candidate,
      sdpMid: data.candidate.sdpMid,
      sdpMLineIndex: data.candidate.sdpMLineIndex,
      usernameFragment: data.candidate.usernameFragment,
    };
    if (this.pc.remoteDescription) await this.addCandidate(init);
    else this.pendingCandidates.push(init);
  }

  private async addCandidate(c: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(c);
    } catch (err) {
      // A bad candidate shouldn't kill the connection; others may still work.
      console.warn('[rtc] ignoring ICE candidate', err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.onicecandidate = null;
    this.pc.close();
  }
}

function serializeCandidate(c: RTCIceCandidate): IceCandidatePayload {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
    usernameFragment: c.usernameFragment,
  };
}
