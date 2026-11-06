(function () {
    'use strict';

    class VoiceControlPlugin {
        constructor({ playbackManager, toast, dashboard, ServerConnections }) {
            this.name = 'Voice Control Plugin';
            this.type = 'skin';
            this.id = 'voiceControlPlugin';
            this.playbackManager = playbackManager;
            this.toast = toast;
            this.dashboard = dashboard;
            this.ServerConnections = ServerConnections;
            this.isListening = false;
            this.recognition = null;
            this.mediaRecorder = null;
            this.preferServerWhisper = localStorage.getItem('jf_voice_use_server') === '1';

            this.init();
        }

        init() {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (SpeechRecognition) {
                this.recognition = new SpeechRecognition();
                this.recognition.continuous = false;
                this.recognition.interimResults = false;
                this.recognition.lang = 'en-US';

                this.recognition.onstart = () => {
                    this.isListening = true;
                    this.updateUI();
                };

                this.recognition.onresult = (event) => {
                    let transcript = event.results[0][0].transcript.toLowerCase();
                    transcript = transcript.replace(/[.,?!]+$/, '');
                    console.log('[VoiceControlPlugin] Heard (WebSpeech) ->', transcript);
                    this.processCommand(transcript);
                };

                this.recognition.onerror = (event) => {
                    this.isListening = false;
                    this.updateUI();
                    if (event.error === 'network' || event.error === 'service-not-allowed') {
                        console.log('[VoiceControlPlugin] WebSpeech network error; falling back to server Whisper transcription');
                        this.preferServerWhisper = true;
                        localStorage.setItem('jf_voice_use_server', '1');
                        this.startServerRecording();
                        return;
                    }
                    if (event.error !== 'aborted' && event.error !== 'no-speech' && this.toast) {
                        this.toast(`Voice error: ${event.error}`);
                    }
                };

                this.recognition.onend = () => {
                    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
                        this.isListening = false;
                        this.updateUI();
                    }
                };
            } else {
                this.preferServerWhisper = true;
            }

            this.injectStyles();
            const observer = new MutationObserver(() => this.ensureToolbarButton());
            observer.observe(document.body, { childList: true, subtree: true });
            this.ensureToolbarButton();
        }

        injectStyles() {
            if (!document.getElementById('jellyfin-voice-styles')) {
                const style = document.createElement('style');
                style.id = 'jellyfin-voice-styles';
                style.innerHTML = `
                    @keyframes voicePulse {
                        0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(255, 82, 82, 0.7); }
                        70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(255, 82, 82, 0); }
                        100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(255, 82, 82, 0); }
                    }
                    .voice-pulse-animation {
                        animation: voicePulse 2s infinite !important;
                        background-color: rgba(255, 0, 0, 0.2) !important;
                    }
                    .voice-pulse-animation .material-icons,
                    .voice-pulse-animation .MuiSvgIcon-root {
                        color: #ff5252 !important;
                    }
                `;
                document.head.appendChild(style);
            }
        }

        ensureToolbarButton() {
            // 1. Legacy UI (.headerRight)
            const headerRight = document.querySelector('.headerRight');
            if (headerRight && !headerRight.querySelector('.headerVoiceButton')) {
                const btn = document.createElement('button');
                btn.setAttribute('is', 'paper-icon-button-light');
                btn.className = 'headerButton headerButtonRight headerVoiceButton paper-icon-button-light';
                btn.title = 'Voice Control';
                btn.innerHTML = '<span class="material-icons mic" aria-hidden="true"></span>';
                btn.addEventListener('click', () => this.toggleVoiceControl());
                const searchBtn = headerRight.querySelector('.headerSearchButton');
                if (searchBtn) {
                    headerRight.insertBefore(btn, searchBtn);
                } else {
                    headerRight.prepend(btn);
                }
            }

            // 2. Modern React UI (.MuiToolbar-root)
            const muiToolbar = document.querySelector('.MuiAppBar-root .MuiToolbar-root');
            if (muiToolbar && !muiToolbar.querySelector('.headerVoiceButton')) {
                const searchLink = muiToolbar.querySelector('a[href*="/search"]');
                const container = searchLink ? searchLink.parentElement : null;
                if (container) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'MuiButtonBase-root MuiIconButton-root MuiIconButton-colorInherit MuiIconButton-sizeLarge headerVoiceButton';
                    btn.title = 'Voice Control';
                    btn.style.cssText = 'color:inherit;border:none;background:transparent;cursor:pointer;padding:12px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;';
                    btn.innerHTML = '<span class="material-icons mic" aria-hidden="true"></span>';
                    btn.addEventListener('click', () => this.toggleVoiceControl());
                    container.insertBefore(btn, searchLink);
                }
            }
        }

        updateUI() {
            document.querySelectorAll('.headerVoiceButton').forEach(btn => {
                btn.classList.toggle('voice-pulse-animation', this.isListening);
            });
        }

        toggleVoiceControl() {
            if (this.isListening) {
                if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                    this.mediaRecorder.stop();
                } else if (this.recognition) {
                    this.recognition.stop();
                }
                return;
            }

            if (this.preferServerWhisper || !this.recognition) {
                this.startServerRecording();
                return;
            }

            try {
                this.recognition.start();
                if (this.toast) this.toast('Listening...');
            } catch (e) {
                console.warn('[VoiceControlPlugin] WebSpeech start failed, falling back to Server Whisper', e);
                this.preferServerWhisper = true;
                this.startServerRecording();
            }
        }

        async startServerRecording() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                if (this.toast) this.toast('Microphone access requires HTTPS or localhost.');
                return;
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const chunks = [];
                this.mediaRecorder = new MediaRecorder(stream);
                this.isListening = true;
                this.updateUI();
                if (this.toast) this.toast('Listening...');

                // Silence detection via Web Audio AnalyserNode
                let audioCtx = null;
                let silenceTimer = null;
                let maxTimer = null;
                let spoke = false;

                try {
                    const AudioCtx = window.AudioContext || window.webkitAudioContext;
                    if (AudioCtx) {
                        audioCtx = new AudioCtx();
                        const source = audioCtx.createMediaStreamSource(stream);
                        const analyser = audioCtx.createAnalyser();
                        analyser.fftSize = 512;
                        source.connect(analyser);
                        const data = new Uint8Array(analyser.fftSize);
                        let silentSince = null;

                        silenceTimer = setInterval(() => {
                            if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') return;
                            analyser.getByteTimeDomainData(data);
                            let maxDev = 0;
                            for (let i = 0; i < data.length; i++) {
                                const dev = Math.abs(data[i] - 128);
                                if (dev > maxDev) maxDev = dev;
                            }
                            if (maxDev > 10) {
                                spoke = true;
                                silentSince = null;
                            } else if (spoke) {
                                if (!silentSince) {
                                    silentSince = Date.now();
                                } else if (Date.now() - silentSince > 1100) {
                                    this.mediaRecorder.stop();
                                }
                            }
                        }, 100);
                    }
                } catch (err) {
                    console.warn('[VoiceControlPlugin] Silence detector unavailable, using timer', err);
                }

                maxTimer = setTimeout(() => {
                    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                        this.mediaRecorder.stop();
                    }
                }, 4500);

                this.mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) chunks.push(e.data);
                };

                this.mediaRecorder.onstop = async () => {
                    if (silenceTimer) clearInterval(silenceTimer);
                    if (maxTimer) clearTimeout(maxTimer);
                    if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
                    stream.getTracks().forEach(t => t.stop());

                    this.isListening = false;
                    this.updateUI();

                    const blob = new Blob(chunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
                    if (blob.size < 500) return;

                    if (this.toast) this.toast('Transcribing...');
                    try {
                        const apiClient = this.ServerConnections.currentApiClient();
                        const url = apiClient ? apiClient.getUrl('VoiceControl/Transcribe') : '/VoiceControl/Transcribe';
                        const resp = await fetch(url, {
                            method: 'POST',
                            body: blob
                        });
                        const data = await resp.json();
                        if (data && data.text) {
                            console.log('[VoiceControlPlugin] Heard (Server Whisper) ->', data.text);
                            this.processCommand(data.text);
                        } else if (this.toast) {
                            this.toast('Did not catch any speech.');
                        }
                    } catch (err) {
                        console.error('[VoiceControlPlugin] Server transcription error', err);
                        if (this.toast) this.toast('Voice transcription failed.');
                    }
                };

                this.mediaRecorder.start();
            } catch (err) {
                console.error('[VoiceControlPlugin] Microphone error', err);
                this.isListening = false;
                this.updateUI();
                if (this.toast) this.toast(`Microphone error: ${err.message || err.name}`);
            }
        }

        async processCommand(command) {
            if (this.toast) this.toast(`Heard: "${command}"`);

            let action = 'search';
            let query = command;

            if (command.startsWith('play ')) {
                action = 'play';
                query = command.substring(5).trim();
            } else if (command.startsWith('shuffle ')) {
                action = 'shuffle';
                query = command.substring(8).trim();
            } else if (command.startsWith('listen to ')) {
                action = 'play';
                query = command.substring(10).trim();
            } else if (command === 'visualize' || command === 'visualizer' || command === 'show visualizer') {
                if (window.JellyfinMusicVisualizer) {
                    window.JellyfinMusicVisualizer.open();
                } else {
                    window.location.hash = '#/musicvisualizer';
                }
                return;
            } else if (command === 'info' || command === 'show info') {
                const player = this.playbackManager.getCurrentPlayer();
                const currentItem = player ? this.playbackManager.currentItem(player) : null;
                if (currentItem) {
                    const itemId = currentItem.Id || currentItem.ItemId;
                    const serverId = currentItem.ServerId || this.ServerConnections.currentApiClient()?.serverId();
                    if (itemId && serverId) {
                        window.location.hash = `#/details?id=${itemId}&serverId=${serverId}`;
                        return;
                    }
                }
                if (this.toast) this.toast('Nothing is currently playing.');
                return;
            } else if (command.startsWith('info ') || command.startsWith('who is ')) {
                action = 'info';
                query = command.replace(/^(info|who is) /, '').trim();
            } else if (command.startsWith('find ') || command.startsWith('search for ') || command.startsWith('search ')) {
                action = 'search';
                query = command.replace(/^(find|search for|search) /, '').trim();
            }

            if (!query) return;

            if (action === 'search') {
                window.location.hash = '#/search?query=' + encodeURIComponent(query);
                return;
            }

            const apiClient = this.ServerConnections.currentApiClient();
            if (!apiClient) return;

            try {
                const results = await apiClient.getSearchHints({
                    searchTerm: query,
                    includeItemTypes: 'Audio,MusicAlbum,MusicArtist,Playlist',
                    limit: 10,
                    recursive: true
                });

                if (!results.SearchHints || results.SearchHints.length === 0) {
                    if (this.toast) this.toast(`No results found for: ${query}`);
                    return;
                }

                const bestMatch = results.SearchHints[0];
                if (action === 'info') {
                    window.location.hash = `#/details?id=${bestMatch.ItemId}&serverId=${bestMatch.ServerId}`;
                    return;
                }

                const playOptions = { ids: [bestMatch.ItemId], serverId: bestMatch.ServerId };
                if (action === 'shuffle') {
                    this.playbackManager.shuffle(playOptions);
                    if (this.toast) this.toast(`Shuffling: ${bestMatch.Name}`);
                } else {
                    this.playbackManager.play(playOptions);
                    if (this.toast) this.toast(`Playing: ${bestMatch.Name}`);
                }
            } catch (err) {
                console.error('[VoiceControlPlugin] Search failed', err);
                if (this.toast) this.toast('Search failed.');
            }
        }
    }

    window.voiceControlPlugin = async () => VoiceControlPlugin;
})();
