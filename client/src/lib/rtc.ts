import type { IceCandidatePayload, IceServerConfig, SignalPayload } from '@pizzadrop/shared';

/**
 * Thin wrapper around RTCPeerConnection that speaks our {@link SignalPayload}
 * format and queues remote ICE candidates that arrive before the remote
 * description (which happens routinely with trickle ICE).
 *
 * Every signal carries `conn`, the id of this connection attempt, so a signal that arrives late, twice, or meant
 * for an earlier attempt is recognised and left alone.
 */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private closed = false;

  constructor(
    iceServers: IceServerConfig[],
    readonly conn: string,
    private readonly sendSignal: (data: SignalPayload) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignal({ kind: 'candidate', candidate: serializeCandidate(ev.candidate), conn });
    };
  }

  /** Sender side: create the offer. Call after creating the data channel. */
  async offer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ kind: 'description', description: { type: 'offer', sdp: offer.sdp ?? '' }, conn: this.conn });
  }

  /**
   * Send our description again, e.g. when the first copy may have been lost. It now also lists every candidate
   * gathered so far, so the other side doesn't depend on the trickled ones having arrived.
   */
  resendDescription(): void {
    const d = this.pc.localDescription;
    if (this.closed || !d || (d.type !== 'offer' && d.type !== 'answer')) return;
    this.sendSignal({ kind: 'description', description: { type: d.type, sdp: d.sdp }, conn: this.conn });
  }

  /** True if `data` belongs to this connection (signals without an id come from older senders). */
  owns(data: SignalPayload): boolean {
    return data.conn === undefined || data.conn === this.conn;
  }

  async handleSignal(data: SignalPayload): Promise<void> {
    if (this.closed || !this.owns(data)) return;
    if (data.kind === 'description') {
      // A repeated answer (the other side resent it) has nothing left to do.
      if (data.description.type === 'answer' && this.pc.signalingState === 'stable') return;
      await this.pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal({
          kind: 'description',
          description: { type: 'answer', sdp: answer.sdp ?? '' },
          conn: this.conn,
        });
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
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
    // Not every browser fills this in; `undefined` would vanish from the JSON and fail validation.
    usernameFragment: c.usernameFragment ?? null,
  };
}
