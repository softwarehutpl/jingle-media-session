var util = require('util');
var extend = require('extend-object');
var BaseSession = require('jingle-session');
var RTCPeerConnection = require('rtcpeerconnection');


function filterContentSources(content, stream) {
    if (content.application.applicationType !== 'rtp') {
        return;
    }
    delete content.transport;
    delete content.application.payloads;
    delete content.application.headerExtensions;
    content.application.mux = false;

    if (content.application.sources) {
        content.application.sources = content.application.sources.filter(function (source) {
            // if there's no msid, ignore it
            if (source.parameters.length < 2) {
              return false;
            }
            return stream.id === source.parameters[1].value.split(' ')[0];
        });
    }
    // remove source groups not related to this stream
    if (content.application.sourceGroups) {
        content.application.sourceGroups = content.application.sourceGroups.filter(function (group) {
            var found = false;
            for (var i = 0; i < content.application.sources.length; i++) {
                if (content.application.sources[i].ssrc === group.sources[0]) {
                    found = true;
                    break;
                }
            }
            return found;
        });
    }
}

function filterUnusedLabels(content) {
    // Remove mslabel and label ssrc-specific attributes
    var sources = content.application.sources || [];
    sources.forEach(function (source) {
        source.parameters = source.parameters.filter(function (parameter) {
            return !(parameter.key === 'mslabel' || parameter.key === 'label');
        });
    });
}


function MediaSession(opts) {
    BaseSession.call(this, opts);

    var rtcConfiguration = {
        iceServers: opts.iceServers || [],
        useJingle: true
    };
    if (opts.bundlePolicy) {
        rtcConfiguration.bundlePolicy = opts.bundlePolicy;
    }

    this.pc = new RTCPeerConnection(rtcConfiguration, opts.constraints || {});

    this.pc.on('ice', this.onIceCandidate.bind(this, opts));
    this.pc.on('endOfCandidates', this.onIceEndOfCandidates.bind(this, opts));
    this.pc.on('iceConnectionStateChange', this.onIceStateChange.bind(this));
    this.pc.on('addStream', this.onAddStream.bind(this));
    this.pc.on('removeStream', this.onRemoveStream.bind(this));
    this.pc.on('addChannel', this.onAddChannel.bind(this));
    this.pc.on('addTrack', this.onAddTrack.bind(this));
    this.pc.on('removeTrack', this.onRemoveTrack.bind(this));

    if (opts.stream) {
        this.addStream(opts.stream);
    }

    this._ringing = false;
}


util.inherits(MediaSession, BaseSession);


Object.defineProperties(MediaSession.prototype, {
    ringing: {
        get: function () {
            return this._ringing;
        },
        set: function (value) {
            if (value !== this._ringing) {
                this._ringing = value;
                this.emit('change:ringing', value);
            }
        }
    },
    streams: {
        get: function () {
            if (this.pc.signalingState !== 'closed') {
                return this.pc.getRemoteStreams();
            }
            return [];
        }
    }
});


MediaSession.prototype = extend(MediaSession.prototype, {

    // ----------------------------------------------------------------
    // Session control methods
    // ----------------------------------------------------------------

    start: function (offerOptions, next) {
        var self = this;
        this.state = 'pending';

        next = next || function () {};

        this.pc.isInitiator = true;
        this.pc.offer(offerOptions, function (err, offer) {
            if (err) {
                self._log('error', 'Could not create WebRTC offer (session start)', err);
                return self.end('failed-application', true);
            }

            // a workaround for missing a=sendonly
            // https://code.google.com/p/webrtc/issues/detail?id=1553
            if (offerOptions && offerOptions.mandatory) {
                offer.jingle.contents.forEach(function (content) {
                    var mediaType = content.application.media;

                    if (!content.description || content.application.applicationType !== 'rtp') {
                        return;
                    }

                    if (!offerOptions.mandatory.OfferToReceiveAudio && mediaType === 'audio') {
                        content.senders = 'initiator';
                    }

                    if (!offerOptions.mandatory.OfferToReceiveVideo && mediaType === 'video') {
                        content.senders = 'initiator';
                    }
                });
            }

            offer.jingle.contents.forEach(filterUnusedLabels);

            offer.jingle.cid = self.cid;

            self.send('session-initiate', offer.jingle);

            next();
        });
    },

    accept: function (opts, next) {
        var self = this;

        // support calling with accept(next) or accept(opts, next)
        if (arguments.length === 1 && typeof opts === 'function') {
            next = opts;
            opts = {};
        }
        next = next || function () {};
        opts = opts || {};

        self.constraints = opts.constraints || {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };

        this._log('info', 'Accepted incoming session');

        this.state = 'active';

        this.pc.answer(self.constraints, function (err, answer) {
            if (err) {
                self._log('error', 'Could not create WebRTC answer (session accept)', err);
                return self.end('failed-application');
            }

            answer.jingle.contents.forEach(filterUnusedLabels);

            self.send('session-accept', answer.jingle);

            next();
        });
    },

    end: function (reason, silent) {
        var self = this;
        this.streams.forEach(function (stream) {
            self.onRemoveStream({stream: stream});
        });
        if (this.pc.signalingState !== 'closed') {
            this.pc.close();
        }
        BaseSession.prototype.end.call(this, reason, silent);
    },

    ring: function () {
        this._log('info', 'Ringing on incoming session');
        this.ringing = true;
        this.send('session-info', {ringing: true});
    },

    mute: function (creator, name) {
        this._log('info', 'Muting', name);

        this.send('session-info', {
            mute: {
                creator: creator,
                name: name
            }
        });
    },

    unmute: function (creator, name) {
        this._log('info', 'Unmuting', name);
        this.send('session-info', {
            unmute: {
                creator: creator,
                name: name
            }
        });
    },

    hold: function () {
        this._log('info', 'Placing on hold');
        this.send('session-info', {hold: true});
    },

    resume: function () {
        this._log('info', 'Resuming from hold');
        this.send('session-info', {active: true});
    },

    // ----------------------------------------------------------------
    // Stream control methods
    // ----------------------------------------------------------------

    addStream: function (stream, renegotiate, cb) {
        var self = this;

        cb = cb || function () {};

        this.pc.addStream(stream);

        if (!renegotiate) {
            return;
        } else if (typeof renegotiate === 'object') {
            self.constraints = renegotiate;
        }

        if (this.pc.isInitiator) {
            this.pc.offer(self.constraints, function (err, offer) {
                if (err) {
                    self._log('error', 'Could not create offer for adding new stream', err);
                    return cb(err);
                }
                self.send('source-add', offer.jingle);
                cb();
            });
        } else {
            this.pc.handleOffer({
                type: 'offer',
                jingle: this.pc.remoteDescription
            }, function (err) {
                if (err) {
                    self._log('error', 'Could not process offer for adding new stream', err);
                    return cb(err);
                }
                self.pc.answer(self.constraints, function (err, answer) {
                    if (err) {
                        self._log('error', 'Could not create answer for adding new stream', err);
                        return cb(err);
                    }
                    self.send('source-add', answer.jingle);
                    cb();
                });
            });
        }
    },

    addStream2: function (stream, cb) {
        this.addStream(stream, true, cb);
    },

    removeStream: function (stream, renegotiate, cb) {
        var self = this;

        cb = cb || function () {};

        if (!renegotiate) {
            this.pc.removeStream(stream);
            return;
        } else if (typeof renegotiate === 'object') {
            self.constraints = renegotiate;
        }

        this.send('source-remove', this.pc.localDescription);
        this.pc.removeStream(stream);

        if (this.pc.isInitiator) {
            this.pc.offer(self.constraints, function (err) {
                if (err) {
                    self._log('error', 'Could not create offer for removing stream', err);
                    return cb(err);
                }
                self.pc.handleAnswer({
                    type: 'answer',
                    jingle: self.pc.remoteDescription
                }, function (err) {
                    if (err) {
                        self._log('error', 'Could not process answer for removing stream', err);
                        return cb(err);
                    }
                    cb();
                });
            });
        } else {
            this.pc.handleOffer({
                type: 'offer',
                jingle: this.pc.remoteDescription
            }, function (err) {
                if (err) {
                    self._log('error', 'Could not process offer for removing stream', err);
                    return cb(err);
                }
                self.pc.answer(self.constraints, function (err) {
                    if (err) {
                        self._log('error', 'Could not create answer for removing stream', err);
                        return cb(err);
                    }
                    cb();
                });
            });
        }
    },

    removeStream2: function (stream, cb) {
        this.removeStream(stream, true, cb);
    },

    switchStream: function (oldStream, newStream, cb) {
        var self = this;

        cb = cb || function () {};

        this.pc.removeStream(oldStream);
        this.send('source-remove', this.pc.localDescription);
        this.pc.addStream(newStream);

        if (this.pc.isInitiator) {
            this.pc.offer(self.constraints, function (err, offer) {
                if (err) {
                    self._log('error', 'Could not create offer for switching streams', err);
                    return cb(err);
                }
                self.send('source-add', offer.jingle);
                cb();
            });
        } else {
            this.pc.handleOffer({
                type: 'offer',
                jingle: this.pc.remoteDescription
            }, function (err) {
                if (err) {
                    self._log('error', 'Could not process offer for switching streams', err);
                    return cb(err);
                }
                self.pc.answer(self.constraints, function (err, answer) {
                    if (err) {
                        self._log('error', 'Could not create answer for switching streams', err);
                        return cb(err);
                    }
                    self.send('source-add', answer.jingle);
                    cb();
                });
            });
        }
    },

    // ----------------------------------------------------------------
    // ICE action handers
    // ----------------------------------------------------------------

    onIceCandidate: function (opts, candidate) {
        this._log('info', 'Discovered new ICE candidate', candidate.jingle);
        this.send('transport-info', candidate.jingle);
        if (opts.signalEndOfCandidates) {
            this.lastCandidate = candidate;
        }
    },

    onIceEndOfCandidates: function (opts) {
        this._log('info', 'ICE end of candidates');
        if (opts.signalEndOfCandidates) {
            var endOfCandidates = this.lastCandidate.jingle;
            endOfCandidates.contents[0].transport = {
                transportType: endOfCandidates.contents[0].transport.transportType,
                gatheringComplete: true
            };
            this.lastCandidate = null;
            this.send('transport-info', endOfCandidates);
        }
    },

    onIceStateChange: function () {
        switch (this.pc.iceConnectionState) {
            case 'checking':
                this.connectionState = 'connecting';
                break;
            case 'completed':
            case 'connected':
                this.connectionState = 'connected';
                break;
            case 'disconnected':
                if (this.pc.signalingState === 'stable') {
                    this.connectionState = 'interrupted';
                } else {
                    this.connectionState = 'disconnected';
                }
                break;
            case 'failed':
                this.connectionState = 'failed';
                this.end('failed-transport');
                break;
            case 'closed':
                this.connectionState = 'disconnected';
                break;
        }
    },

    // ----------------------------------------------------------------
    // Stream event handlers
    // ----------------------------------------------------------------

    onAddStream: function (event) {
        this._log('info', 'Stream added');
        this.emit('peerStreamAdded', this, event.stream);
    },

    onRemoveStream: function (event) {
        this._log('info', 'Stream removed');
        this.emit('peerStreamRemoved', this, event.stream);
    },

    // ----------------------------------------------------------------
    // Track event handlers
    // ----------------------------------------------------------------

    onAddTrack: function (event) {
        this._log('info', 'Track added');
        this.emit('peerTrackAdded', this, event.track, event.streams[0]);
    },

    onRemoveTrack: function (event) {
        this._log('info', 'Track removed');
        this.emit('peerTrackRemoved', this, event.track, event.stream);
    },

    // ----------------------------------------------------------------
    // Jingle action handers
    // ----------------------------------------------------------------

    onSessionInitiate: function (changes, cb) {
        var self = this;

        this._log('info', 'Initiating incoming session');

        this.state = 'pending';

        this.pc.isInitiator = false;
        this.pc.handleOffer({
            type: 'offer',
            jingle: changes
        }, function (err) {
            if (err) {
                self._log('error', 'Could not create WebRTC answer (sessionInitiate)', err);
                return cb({condition: 'general-error'});
            }
            cb();
        });
    },

    onSessionAccept: function (changes, cb) {
        var self = this;

        this.state = 'active';
        this.pc.handleAnswer({
            type: 'answer',
            jingle: changes
        }, function (err) {
            if (err) {
                self._log('error', 'Could not process WebRTC answer (sessionAccept)', err);
                return cb({condition: 'general-error'});
            }
            self.emit('accepted', self);
            cb();
        });
    },

    onSessionTerminate: function (changes, cb) {
        var self = this;

        this._log('info', 'Terminating session');
        this.streams.forEach(function (stream) {
            self.onRemoveStream({stream: stream});
        });
        this.pc.close();
        BaseSession.prototype.end.call(this, changes.reason, true);

        cb();
    },

    onSessionInfo: function (info, cb) {
        if (info.ringing) {
            this._log('info', 'Outgoing session is ringing');
            this.ringing = true;
            this.emit('ringing', this);
            return cb();
        }

        if (info.hold) {
            this._log('info', 'On hold');
            this.emit('hold', this);
            return cb();
        }

        if (info.active) {
            this._log('info', 'Resuming from hold');
            this.emit('resumed', this);
            return cb();
        }

        if (info.mute) {
            this._log('info', 'Muting', info.mute);
            this.emit('mute', this, info.mute);
            return cb();
        }

        if (info.unmute) {
            this._log('info', 'Unmuting', info.unmute);
            this.emit('unmute', this, info.unmute);
            return cb();
        }

        cb();
    },

    onTransportInfo: function (changes, cb) {
        this.pc.processIce(changes, function () {
            cb();
        });
    },

    onSourceAdd: function (changes, cb) {
        var self = this;
        this._log('info', 'Adding new stream source');

        if (this.pc.isInitiator) {
            this.pc.offer(this.constraints, function (err, offer) {
                if (err) {
                    self._log('error', 'Error adding new stream source (offer)', err);
                    return cb({
                        condition: 'general-error'
                    });
                }
                self.pc.handleAnswer({
                    type: 'answer',
                    jingle: changes
                }, function (err) {
                    if (err) {
                        self._log('error', 'Error adding new stream source (handleAnswer)', err);
                        return cb({
                            condition: 'general-error'
                        });
                    }
                    cb();
                });
            });
        } else {
            this.pc.handleOffer({
                type: 'offer',
                jingle: changes
            }, function (err) {
                if (err) {
                    self._log('error', 'Error adding new stream source (handleOffer)', err);
                    return cb({
                        condition: 'general-error'
                    });
                }
                self.pc.answer(self.constraints, function (err, answer) {
                    if (err) {
                        self._log('error', 'Error adding new stream source (answer)', err);
                        return cb({
                            condition: 'general-error'
                        });
                    }
                    self.send('source-update', answer.jingle);
                    cb();
                });
            });
        }
    },

    onSourceRemove: function (changes, cb) {
        var self = this;
        this._log('info', 'Removing stream source');

        if (this.pc.isInitiator) {
            this.pc.offer(this.constraints, function (err) {
                if (err) {
                    self._log('error', 'Error removing stream source (offer)', err);
                    return cb({
                        condition: 'general-error'
                    });
                }
                self.pc.handleAnswer({
                    type: 'answer',
                    jingle: changes
                }, function (err) {
                    if (err) {
                        self._log('error', 'Error removing stream source (handleAnswer)', err);
                        return cb({
                            condition: 'general-error'
                        });
                    }
                    cb();
                });
            });
        } else {
            this.pc.handleOffer({
                type: 'offer',
                jingle: changes
            }, function (err) {
                if (err) {
                    self._log('error', 'Error removing stream source (handleOffer)', err);
                    return cb({
                        condition: 'general-error'
                    });
                }
                self.pc.answer(self.constraints, function (err) {
                    if (err) {
                        self._log('error', 'Error removing stream source (answer)', err);
                        return cb({
                            condition: 'general-error'
                        });
                    }
                    cb();
                });
            });
        }
    },

    onSourceUpdate: function (changes, cb) {
        var self = this;
        this._log('info', 'Updating stream source');

        if (changes.reinviteInitiator) {
            this.pc.handleOffer({
                type: 'offer',
                jingle: changes
            }, function (err) {
                if (err) {
                    self._log('error', 'Error handle offer, responder (reinviteInitiator)', err);
                    return cb(err);
                }
                self.pc.answer(self.constraints, function (err, answer) {
                    if (err) {
                        self._log('error', 'Error creating answer, responder (reinviteInitiator)', err);
                        return cb(err);
                    }
                    cb();
                    self.send('source-accept', answer.jingle);
                });
            });
        } else {
          if (this.pc.isInitiator) {
              self.pc.handleAnswer({
                  type: 'answer',
                  jingle: changes
              }, function (err) {
                  if (err) {
                      self._log('error', 'Could not process answer for source update (handleAnswer)', err);
                      return cb(err);
                  }
                  cb();
              });
          } else {
              this.pc.handleOffer({
                  type: 'offer',
                  jingle: changes
              }, function (err) {
                  if (err) {
                      self._log('error', 'Could not process offer for source update (handleOffer)', err);
                      return cb(err);
                  }
                  cb();
              });
          }
        }
    },

    onSourceAccept: function (changes, cb) {
        cb();
    },

    // ----------------------------------------------------------------
    // DataChannels
    // ----------------------------------------------------------------
    onAddChannel: function (channel) {
        this.emit('addChannel', channel);
    }
});

module.exports = MediaSession;
