window.addEventListener('DOMContentLoaded', () => {

    // --- 画面アスペクト比固定 ＆ スケーリング ---
    function resizeGame() {
        const container = document.getElementById('game-container');
        if (!container) return;
        const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
        container.style.transform = `scale(${scale})`;
    }
    window.addEventListener('resize', resizeGame);
    resizeGame();

    // --- 音声管理システム (Web Audio API & シームレスクロスフェード) ---
    let audioCtx = null;

    function getAudioContext() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function unlockAudio() {
        const ctx = getAudioContext();
        if (ctx && ctx.state === 'running') {
            window.removeEventListener('click', unlockAudio);
            window.removeEventListener('keydown', unlockAudio);
        }
        // HTMLAudioElement 側の再生制限解除用
        Object.values(audioElements).forEach(pair => {
            if (pair) {
                pair.a.play().then(() => { pair.a.pause(); pair.a.currentTime = 0; }).catch(() => {});
                pair.b.play().then(() => { pair.b.pause(); pair.b.currentTime = 0; }).catch(() => {});
            }
        });
    }
    window.addEventListener('click', unlockAudio);
    window.addEventListener('keydown', unlockAudio);

    const soundKeys = ['stepping', 'blower', 'compressor', 'airBrake'];
    const audioBuffers = {};
    const loopStates = {};

    // ダブルバッファリング用 HTML Audio エレメント (file:// 閲覧時などのフォールバック)
    const audioElements = {};
    soundKeys.forEach(key => {
        audioBuffers[key] = null;
        loopStates[key] = { active: false, timer: null, activePlayer: 'a' };
        audioElements[key] = {
            a: new Audio(`${key}.wav`),
            b: new Audio(`${key}.wav`)
        };
    });

    // WAV音声ファイルのロードとクロスフェード処理済み Buffer の生成
    async function loadAudio(key, url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const ctx = getAudioContext();
            const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);

            // ループ音の繋ぎ目を滑らかにするクロスフェード処理
            audioBuffers[key] = createCrossfadedBuffer(ctx, decodedBuffer, 0.05); // 0.05秒のフェード処理
            console.log(`Web Audio API シームレスバッファ生成成功: ${key}`);
        } catch (e) {
            console.warn(`Web Audio API でのロードに失敗 (${url})。HTML Audio デュアル再生に切り替えます。`, e);
        }
    }

    // 前後の音源端部をわずかにオーバーラップ・フェードイン/アウトさせるヘルパー
    function createCrossfadedBuffer(ctx, origBuffer, fadeTime) {
        const numChannels = origBuffer.numberOfChannels;
        const sampleRate = origBuffer.sampleRate;
        const fadeSamples = Math.floor(fadeTime * sampleRate);
        
        if (origBuffer.length <= fadeSamples * 2) return origBuffer;

        const newBuffer = ctx.createBuffer(numChannels, origBuffer.length, sampleRate);

        for (let channel = 0; channel < numChannels; channel++) {
            const srcData = origBuffer.getChannelData(channel);
            const dstData = newBuffer.getChannelData(channel);
            dstData.set(srcData);

            for (let i = 0; i < fadeSamples; i++) {
                const alpha = i / fadeSamples;
                // 開始部分のフェードイン処理（終端の音と滑らかに結合）
                dstData[i] = dstData[i] * alpha + srcData[origBuffer.length - fadeSamples + i] * (1 - alpha);
                // 終了部分のフェードアウト処理
                dstData[origBuffer.length - fadeSamples + i] = srcData[origBuffer.length - fadeSamples + i] * (1 - alpha) + srcData[i] * alpha;
            }
        }
        return newBuffer;
    }

    soundKeys.forEach(key => loadAudio(key, `${key}.wav`));

    // 再生ヘルパー関数 (Web Audio優先、失敗時はHTML Audioダブルバッファ)
    function playLoopSound(key) {
        if (loopStates[key].active) return;
        loopStates[key].active = true;

        // 1. Web Audio API での再生
        if (audioBuffers[key]) {
            const ctx = getAudioContext();
            const source = ctx.createBufferSource();
            source.buffer = audioBuffers[key];
            source.loop = true;
            source.connect(ctx.destination);
            source.start(0);
            loopStates[key].webAudioSource = source;
            return;
        }

        // 2. フォールバック (HTML Audio シームレスダブルバッファ)
        const pair = audioElements[key];
        if (!pair) return;

        const duration = pair.a.duration || 2.0;
        const overlap = 0.1; // 重ね合わせ時間 (秒)

        function triggerNext() {
            if (!loopStates[key].active) return;

            const current = pair[loopStates[key].activePlayer];
            const nextPlayerKey = loopStates[key].activePlayer === 'a' ? 'b' : 'a';
            const next = pair[nextPlayerKey];

            next.currentTime = 0;
            next.play().catch(() => {});

            loopStates[key].activePlayer = nextPlayerKey;

            const interval = Math.max(0.1, (duration - overlap)) * 1000;
            loopStates[key].timer = setTimeout(triggerNext, interval);
        }

        pair.a.currentTime = 0;
        pair.a.play().catch(() => {});
        loopStates[key].activePlayer = 'a';
        
        if (duration > overlap) {
            const interval = (duration - overlap) * 1000;
            loopStates[key].timer = setTimeout(triggerNext, interval);
        }
    }

    // 停止ヘルパー関数
    function stopLoopSound(key) {
        loopStates[key].active = false;

        if (loopStates[key].timer) {
            clearTimeout(loopStates[key].timer);
            loopStates[key].timer = null;
        }

        // 1. Web Audio API 停止
        if (loopStates[key].webAudioSource) {
            try {
                loopStates[key].webAudioSource.stop();
                loopStates[key].webAudioSource.disconnect();
            } catch (e) {}
            loopStates[key].webAudioSource = null;
        }

        // 2. HTML Audio 停止
        const pair = audioElements[key];
        if (pair) {
            pair.a.pause();
            pair.a.currentTime = 0;
            pair.b.pause();
            pair.b.currentTime = 0;
        }
    }

    // --- 状態変数 ---
    let pantaOn = false;
    let abbOn = false;
    let lightMode = 0;
    let reverser = 0;
    let holdBrakeOn = false;

    // --- 走行路線（'down' : 下り線[登り坂] / 'up' : 上り線[下り坂]） ---
    let selectedTrack = 'down';

    let speed = 0;
    let notch = 0;          
    let currentStep = 0;    
    let brake = 0;
    let prevBrake = 0;
    let motorCurrent = 0;   
    let isStepping = false; 

    // 空気圧変数 (kPa)
    let mrPressure = 780; 
    let bcPressure = 0;   

    // タイマー・制御フラグ
    let blowerTimer = 0;
    let isBlowerActive = false;
    let isCompressorActive = false;

    let stepTimer = 0;
    const STEP_INTERVAL = 0.625;
    const notchSpeedLimits = [0, 10, 20, 30, 40, 50, 60, 70, 80];

    // --- Three.js 3D セットアップ ---
    const canvasElem = document.getElementById('canvas-view');
    if (!canvasElem) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1128);

    const camera = new THREE.PerspectiveCamera(60, 1280 / 396, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas: canvasElem, antialias: true });
    renderer.setSize(1280, 396);
    // タブレットやモバイル端末でのライト発色・光量計算を正常化する設定
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    

    const ambientLight = new THREE.AmbientLight(0x6688aa, 0.8);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(100, 200, 100);
    scene.add(dirLight);

    const headLight = new THREE.SpotLight(0xffffff, 0, 300, Math.PI / 4, 0.3, 0);
    scene.add(headLight);
    scene.add(headLight.target);

    // --- マテリアル定義 ---
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x1e381e, side: THREE.DoubleSide });
    const ballastMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.9, roughness: 0.1 });
    const tieMat = new THREE.MeshLambertMaterial({ color: 0x5c4033 });
    const mountainMat = new THREE.MeshLambertMaterial({ color: 0x1a331a });

    // 勾配標用テクスチャ作成
    function createGradientTexture(gradientVal) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 128, 256);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 8;
        ctx.strokeRect(4, 4, 120, 248);

        ctx.fillStyle = '#000000';
        ctx.font = 'bold 36px sans-serif';
        ctx.textAlign = 'center';

        const absGrad = Math.abs(gradientVal).toFixed(1);
        if (Math.abs(gradientVal) < 0.5) {
            ctx.fillText("L", 64, 140);
        } else if (gradientVal > 0) {
            ctx.fillText("入", 64, 80);
            ctx.fillText(absGrad, 64, 160);
        } else {
            ctx.fillText("出", 64, 80);
            ctx.fillText(absGrad, 64, 160);
        }

        return new THREE.CanvasTexture(canvas);
    }

    // --- 単線コース生成システム ---
    const CHUNK_SIZE = 200;
    let activeChunks = [];
    let lastPoint = new THREE.Vector3(0, 0, 0);
    let lastDir = new THREE.Vector3(0, 0, 1);
    let globalDistance = 0;

    function resetTrackWorld() {
        activeChunks.forEach(chunk => {
            chunk.objects.forEach(obj => {
                scene.remove(obj);
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (obj.material.map) obj.material.map.dispose();
                    obj.material.dispose();
                }
            });
        });
        activeChunks = [];
        lastPoint = new THREE.Vector3(0, 0, 0);
        lastDir = new THREE.Vector3(0, 0, 1);
        globalDistance = 0;
        speed = 0;

        generateChunk(0);
        generateChunk(1);
        generateChunk(2);
    }

    function generateChunk(chunkIndex) {
        const objects = [];
        const curvePoints = [];

        let currentPt = lastPoint.clone();
        let currentDir = lastDir.clone();

        curvePoints.push(currentPt.clone());

        const firstControlPt = currentPt.clone().add(currentDir.clone().multiplyScalar(20));
        curvePoints.push(firstControlPt);
        currentPt = firstControlPt.clone();

        const numSegments = 4;
        const baseSlopePerSegment = (selectedTrack === 'down' ? 1.5 : -1.5);

        for (let i = 0; i < numSegments; i++) {
            const turnAngle = (Math.random() - 0.5) * 0.25; 
            currentDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), turnAngle).normalize();

            const segmentLength = (CHUNK_SIZE - 20) / numSegments;
            const nextPt = currentPt.clone().add(currentDir.clone().multiplyScalar(segmentLength));
            
            nextPt.y += baseSlopePerSegment + (Math.random() - 0.5) * 0.8; 

            curvePoints.push(nextPt.clone());
            currentPt = nextPt;
        }

        lastPoint = currentPt.clone();
        lastDir = currentDir.clone();

        const trackPath = new THREE.CatmullRomCurve3(curvePoints, false, 'centripetal');
        const upVec = new THREE.Vector3(0, 1, 0);

        // 1. 地面
        // 1. 地面（左右に分離して中央のバラストを露出させる）
        const groundSamples = 60;
        const halfGroundWidth = 150; // 片側の地面の幅
        const ballastBottomHalf = 1.8; // バラストの底面の半幅

        const groundGeoLeft = new THREE.BufferGeometry();
        const groundGeoRight = new THREE.BufferGeometry();
        const vLeft = [], iLeft = [];
        const vRight = [], iRight = [];

        for (let i = 0; i <= groundSamples; i++) {
            const u = i / groundSamples;
            const pt = trackPath.getPointAt(u);
            const dir = trackPath.getTangentAt(u).normalize();
            const side = new THREE.Vector3().crossVectors(upVec, dir).normalize();

            // 左側の地面（バラストの左端から外側へ）
            const pL_inner = pt.clone().add(side.clone().multiplyScalar(-ballastBottomHalf)).add(new THREE.Vector3(0, -0.41, 0));
            const pL_outer = pt.clone().add(side.clone().multiplyScalar(-halfGroundWidth)).add(new THREE.Vector3(0, -0.41, 0));
            vLeft.push(pL_outer.x, pL_outer.y, pL_outer.z);
            vLeft.push(pL_inner.x, pL_inner.y, pL_inner.z);

            // 右側の地面（バラストの右端から外側へ）
            const pR_inner = pt.clone().add(side.clone().multiplyScalar(ballastBottomHalf)).add(new THREE.Vector3(0, -0.41, 0));
            const pR_outer = pt.clone().add(side.clone().multiplyScalar(halfGroundWidth)).add(new THREE.Vector3(0, -0.41, 0));
            vRight.push(pR_inner.x, pR_inner.y, pR_inner.z);
            vRight.push(pR_outer.x, pR_outer.y, pR_outer.z);

            if (i < groundSamples) {
                const base = i * 2;
                iLeft.push(base, base + 1, base + 2);
                iLeft.push(base + 1, base + 3, base + 2);
                iRight.push(base, base + 1, base + 2);
                iRight.push(base + 1, base + 3, base + 2);
            }
        }

        groundGeoLeft.setAttribute('position', new THREE.Float32BufferAttribute(vLeft, 3));
        groundGeoLeft.setIndex(iLeft);
        groundGeoLeft.computeVertexNormals();

        groundGeoRight.setAttribute('position', new THREE.Float32BufferAttribute(vRight, 3));
        groundGeoRight.setIndex(iRight);
        groundGeoRight.computeVertexNormals();

        const groundMeshLeft = new THREE.Mesh(groundGeoLeft, groundMat);
        const groundMeshRight = new THREE.Mesh(groundGeoRight, groundMat);

        scene.add(groundMeshLeft);
        scene.add(groundMeshRight);
        objects.push(groundMeshLeft);
        objects.push(groundMeshRight);

        // 2. 単線バラスト (正確なメッシュ生成)
        // 2. バラスト (上面と左右の斜面を確実に描画)
        const ballastSamples = 60;
        const topWidthHalf = 1.2;    // バラスト上面の幅（片側1.2m）
        const bottomWidthHalf = 1.8; // バラスト底面の幅（片側1.8m）
        const topY = 0.0;            // 上面高さ
        const bottomY = -0.4;        // 底面高さ

        const ballastGeo = new THREE.BufferGeometry();
        const bVertices = [];
        const bIndices = [];

        for (let i = 0; i <= ballastSamples; i++) {
            const u = i / ballastSamples;
            const pt = trackPath.getPointAt(u);
            const dir = trackPath.getTangentAt(u).normalize();
            const side = new THREE.Vector3().crossVectors(upVec, dir).normalize();

            // 1断面につき4つの頂点を定義（底左、上左、上右、底右）
            const pBottomLeft  = pt.clone().add(side.clone().multiplyScalar(-bottomWidthHalf)).add(new THREE.Vector3(0, bottomY, 0));
            const pTopLeft     = pt.clone().add(side.clone().multiplyScalar(-topWidthHalf)).add(new THREE.Vector3(0, topY, 0));
            const pTopRight    = pt.clone().add(side.clone().multiplyScalar(topWidthHalf)).add(new THREE.Vector3(0, topY, 0));
            const pBottomRight = pt.clone().add(side.clone().multiplyScalar(bottomWidthHalf)).add(new THREE.Vector3(0, bottomY, 0));

            bVertices.push(pBottomLeft.x,  pBottomLeft.y,  pBottomLeft.z);  // index: i*4 + 0
            bVertices.push(pTopLeft.x,     pTopLeft.y,     pTopLeft.z);     // index: i*4 + 1
            bVertices.push(pTopRight.x,    pTopRight.y,    pTopRight.z);    // index: i*4 + 2
            bVertices.push(pBottomRight.x, pBottomRight.y, pBottomRight.z); // index: i*4 + 3

            if (i < ballastSamples) {
                const curr = i * 4;
                const next = (i + 1) * 4;

                // 左斜面 (BottomLeft -> TopLeft)
                bIndices.push(curr + 0, curr + 1, next + 1);
                bIndices.push(curr + 0, next + 1, next + 0);

                // 上面 (TopLeft -> TopRight) ★線路直下を塞ぐグレーの面
                bIndices.push(curr + 1, curr + 2, next + 2);
                bIndices.push(curr + 1, next + 2, next + 1);

                // 右斜面 (TopRight -> BottomRight)
                bIndices.push(curr + 2, curr + 3, next + 3);
                bIndices.push(curr + 2, next + 3, next + 2);
            }
        }

        ballastGeo.setAttribute('position', new THREE.Float32BufferAttribute(bVertices, 3));
        ballastGeo.setIndex(bIndices);
        ballastGeo.computeVertexNormals();

        // 影の影響で黒く沈まないよう、明度の高いグレーのBasicMaterialに指定
        const ballastMat = new THREE.MeshLambertMaterial({ color: 0x555555, side: THREE.DoubleSide });
        const ballastMesh = new THREE.Mesh(ballastGeo, ballastMat);

        scene.add(ballastMesh);
        objects.push(ballastMesh);

        // 3. 枕木・レール・勾配標
        const samples = 80;
        const tieGeo = new THREE.BoxGeometry(2.4, 0.1, 0.35);
        const leftRailPoints = [];
        const rightRailPoints = [];

        for (let i = 0; i <= samples; i++) {
            const u = i / samples;
            const pt = trackPath.getPointAt(u);
            const dir = trackPath.getTangentAt(u).normalize();
            const side = new THREE.Vector3().crossVectors(upVec, dir).normalize();
            const correctedUp = new THREE.Vector3().crossVectors(dir, side).normalize();

            const matrix = new THREE.Matrix4().makeBasis(side, correctedUp, dir);

            const tie = new THREE.Mesh(tieGeo, tieMat);
            tie.position.copy(pt).add(new THREE.Vector3(0, 0.05, 0));
            tie.quaternion.setFromRotationMatrix(matrix);
            scene.add(tie);
            objects.push(tie);

            leftRailPoints.push(pt.clone().add(side.clone().multiplyScalar(-0.75)).add(new THREE.Vector3(0, 0.15, 0)));
            rightRailPoints.push(pt.clone().add(side.clone().multiplyScalar(0.75)).add(new THREE.Vector3(0, 0.15, 0)));

            if (i % 25 === 0 && i > 0) {
                const horizontalLen = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
                const grad = horizontalLen > 0 ? (dir.y / horizontalLen) * 1000 : 0;
                
                const markerMat = new THREE.MeshBasicMaterial({ map: createGradientTexture(grad) });
                const markerGeo = new THREE.BoxGeometry(0.4, 1.2, 0.1);
                const marker = new THREE.Mesh(markerGeo, markerMat);

                const markerPos = pt.clone().add(side.clone().multiplyScalar(-2.2)).add(new THREE.Vector3(0, 0.6, 0));
                marker.position.copy(markerPos);
                marker.quaternion.setFromRotationMatrix(matrix);
                scene.add(marker);
                objects.push(marker);
            }
        }

        const leftRailCurve = new THREE.CatmullRomCurve3(leftRailPoints);
        const leftRailGeo = new THREE.TubeGeometry(leftRailCurve, 80, 0.08, 6, false);
        const leftRailMesh = new THREE.Mesh(leftRailGeo, railMat);
        scene.add(leftRailMesh);
        objects.push(leftRailMesh);

        const rightRailCurve = new THREE.CatmullRomCurve3(rightRailPoints);
        const rightRailGeo = new THREE.TubeGeometry(rightRailCurve, 80, 0.08, 6, false);
        const rightRailMesh = new THREE.Mesh(rightRailGeo, railMat);
        scene.add(rightRailMesh);
        objects.push(rightRailMesh);

        // 4. 山の生成
        const numMountains = 5;
        for (let i = 0; i < numMountains; i++) {
            const u = Math.random();
            const pt = trackPath.getPointAt(u);
            const dir = trackPath.getTangentAt(u).normalize();
            const side = new THREE.Vector3().crossVectors(upVec, dir).normalize();

            const sideOffset = (Math.random() > 0.5 ? 1 : -1) * (60 + Math.random() * 40);
            const mountPos = pt.clone().add(side.multiplyScalar(sideOffset));
            
            const radius = 35 + Math.random() * 25;
            const height = 50 + Math.random() * 40;
            const mountGeo = new THREE.ConeGeometry(radius, height, 6);
            
            mountGeo.scale(1 + (Math.random() - 0.5) * 0.4, 1, 1 + (Math.random() - 0.5) * 0.4);
            
            const mountain = new THREE.Mesh(mountGeo, mountainMat);
            mountain.position.copy(mountPos);
            mountain.position.y = (pt.y - 0.4) + (height / 2) - 1.0; 
            scene.add(mountain);
            objects.push(mountain);
        }

        activeChunks.push({
            index: chunkIndex,
            path: trackPath,
            objects: objects
        });
    }

    function removeOldChunks(currentDist) {
        while (activeChunks.length > 0) {
            const firstChunk = activeChunks[0];
            if (currentDist > (firstChunk.index + 2) * CHUNK_SIZE) {
                firstChunk.objects.forEach(obj => {
                    scene.remove(obj);
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (obj.material.map) obj.material.map.dispose();
                        obj.material.dispose();
                    }
                });
                activeChunks.shift();
            } else {
                break;
            }
        }
    }

    generateChunk(0);
    generateChunk(1);
    generateChunk(2);

    // --- UI操作・スイッチ関連 ---
    window.selectTrackTab = function(trackType) {
        if (selectedTrack === trackType) return;
        selectedTrack = trackType;

        const tabDown = document.getElementById('tab-down-track');
        const tabUp = document.getElementById('tab-up-track');

        if (tabDown && tabUp) {
            if (selectedTrack === 'down') {
                tabDown.classList.add('active-tab');
                tabUp.classList.remove('active-tab');
            } else {
                tabUp.classList.add('active-tab');
                tabDown.classList.remove('active-tab');
            }
        }

        resetTrackWorld();
    };

    window.cycleReverser = function() {
        reverser = reverser === 1 ? -1 : reverser + 1;
        const labels = { 1: "前進 (F)", 0: "中立 (N)", "-1": "後進 (R)" };
        const btn = document.getElementById('btn-reverser');
        if (btn) {
            btn.textContent = `逆転機: ${labels[reverser]}`;
            btn.classList.toggle('btn-active', reverser !== 0);
        }
    };

    window.togglePanta = function() {
        pantaOn = !pantaOn;
        const btn = document.getElementById('btn-panta');
        if (btn) {
            btn.textContent = `パンタグラフ: ${pantaOn ? '上昇' : '降下'}`;
            btn.classList.toggle('btn-active', pantaOn);
        }
        checkBlowerStart();
    };

    window.toggleABB = function() {
        if (!pantaOn) { alert("パンタグラフを上昇させてください。"); return; }
        abbOn = !abbOn;
        const btn = document.getElementById('btn-abb');
        if (btn) {
            btn.textContent = `主開閉器 (ABB): ${abbOn ? '投入' : '切'}`;
            btn.classList.toggle('btn-active', abbOn);
        }
        checkBlowerStart();
    };

    function checkBlowerStart() {
        if (pantaOn && abbOn) {
            if (!isBlowerActive) {
                isBlowerActive = true;
                blowerTimer = 10.0;
                playLoopSound('blower');
            }
        } else {
            isBlowerActive = false;
            stopLoopSound('blower');
        }
    }

    window.cycleLight = function() {
        lightMode = (lightMode + 1) % 3;
        const labels = ["OFF", "減光", "全光"];
        const btn = document.getElementById('btn-light');
        if (btn) {
            btn.textContent = `ヘッドライト: ${labels[lightMode]}`;
            btn.classList.toggle('btn-active', lightMode > 0);
        }
        headLight.intensity = lightMode === 1 ? 3.5 : (lightMode === 2 ? 0.75 : 0);
    };

    window.toggleHoldBrake = function() {
        holdBrakeOn = !holdBrakeOn;
        const btn = document.getElementById('btn-hold-brake');
        if (btn) {
            btn.textContent = `抑速ブレーキ: ${holdBrakeOn ? '入' : '切'}`;
            btn.classList.toggle('btn-active-yellow', holdBrakeOn);
        }
    };

    window.updateNotch = function(val) { 
        notch = parseInt(val); 
        const elem = document.getElementById('val-notch');
        if (elem) elem.textContent = notch; 
    };

    window.updateBrake = function(val) { 
        brake = parseInt(val); 
        const elem = document.getElementById('val-brake');
        if (elem) elem.textContent = brake; 
    };

    window.addEventListener('keydown', (e) => {
        const notchSlider = document.getElementById('notch-slider');
        const brakeSlider = document.getElementById('brake-slider');

        if (e.key === 'w' || e.key === 'W') {
            if (notch < 8) { notch++; if(notchSlider) notchSlider.value = notch; window.updateNotch(notch); }
        } else if (e.key === 's' || e.key === 'S') {
            if (notch > 0) { notch--; if(notchSlider) notchSlider.value = notch; window.updateNotch(notch); }
        } else if (e.key === 'd' || e.key === 'D') {
            if (brake < 8) { brake++; if(brakeSlider) brakeSlider.value = brake; window.updateBrake(brake); }
        } else if (e.key === 'a' || e.key === 'A') {
            if (brake > 0) { brake--; if(brakeSlider) brakeSlider.value = brake; window.updateBrake(brake); }
        }
    });

    // --- メインループ ---
    let lastTime = performance.now();
    // 時刻に基づいて空の色とライティングを滑らかに補色・調整する関数（追記）
    function updateEnvironmentByTime(hours, minutes) {
        // 現在時刻を 0.0 〜 24.0 の小数値に変換（例: 17:30 ➔ 17.5）
        const timeVal = hours + minutes / 60;

        let skyColor = new THREE.Color();
        let lightIntensity = 1.0;

        if (timeVal >= 5 && timeVal < 7) {
            // 【早朝 5:00 - 7:00】夜空(暗青) ➔ 朝焼け(オレンジ/薄ピンク)
            const t = (timeVal - 5) / 2;
            skyColor.lerpColors(new THREE.Color(0x0a1128), new THREE.Color(0xff8c66), t);
            lightIntensity = THREE.MathUtils.lerp(0.3, 0.8, t);
        } else if (timeVal >= 7 && timeVal < 16) {
            // 【昼間 7:00 - 16:00】澄んだ青空
            skyColor.setHex(0x60a5fa);
            lightIntensity = 1.0;
        } else if (timeVal >= 16 && timeVal < 19) {
            // 【夕方 16:00 - 19:00】青空 ➔ 夕焼け(茜色) ➔ 宵の口(深紫)
            const t = (timeVal - 16) / 3;
            skyColor.lerpColors(new THREE.Color(0x60a5fa), new THREE.Color(0xd97706), t);
            lightIntensity = THREE.MathUtils.lerp(1.0, 0.4, t);
        } else {
            // 【夜間 19:00 - 5:00】濃いネイビー（夜空）
            skyColor.setHex(0x020205);
            lightIntensity = 0.02;
        }

        // シーンの背景色を更新
        scene.background = skyColor;

        // シーン内の環境光（DirectionalLightやAmbientLight）の明るさを調整
        scene.traverse((child) => {
            if (child.isLight && !child.isSpotLight) {
              child.intensity = lightIntensity;
            } 
        });
    }

    function animate(now) {
        let dt = (now - lastTime) / 1000;
        if (dt > 0.1) dt = 0.1;
        lastTime = now;

        const maxGeneratedChunkIndex = activeChunks[activeChunks.length - 1].index;
        if (globalDistance > (maxGeneratedChunkIndex - 1) * CHUNK_SIZE) {
            generateChunk(maxGeneratedChunkIndex + 1);
        }
        removeOldChunks(globalDistance);

        let currentChunk = activeChunks[0];
        let localDist = globalDistance;

        for (let chunk of activeChunks) {
            const chunkStart = chunk.index * CHUNK_SIZE;
            const chunkEnd = chunkStart + CHUNK_SIZE;
            if (globalDistance >= chunkStart && globalDistance < chunkEnd) {
                currentChunk = chunk;
                localDist = globalDistance - chunkStart;
                break;
            }
        }

        let progress = Math.max(0, Math.min(1, localDist / CHUNK_SIZE));
        
        const camPos = currentChunk.path.getPointAt(progress);
        const camDir = currentChunk.path.getTangentAt(progress).normalize();

        const horizontalLen = Math.sqrt(camDir.x * camDir.x + camDir.z * camDir.z);
        let gradient = horizontalLen > 0 ? (camDir.y / horizontalLen) * 1000 : 0;
        gradient = Math.max(-66.7, Math.min(66.7, gradient));

        const absSpeed = Math.abs(speed);
        const canElectrify = pantaOn && abbOn && reverser !== 0;

        // 電流・進段制御
        if (canElectrify && (notch > 0 || currentStep > 0)) {
            if (currentStep !== notch) {
                isStepping = true;
                stepTimer += dt;
                if (stepTimer >= STEP_INTERVAL) {
                    if (currentStep < notch) {
                        currentStep++;
                    } else if (currentStep > notch) {
                        currentStep--;
                    }
                    stepTimer = 0;
                }
            } else {
                isStepping = false;
                stepTimer = 0;
            }

            const targetSpeed = notchSpeedLimits[currentStep];
            const speedRatio = Math.min(absSpeed / (targetSpeed || 1), 1.0);
            let baseCurrent = (currentStep * 90) * (1 - speedRatio * 0.6);

            const effectiveGradient = gradient * reverser;
            if (effectiveGradient > 0) {
                baseCurrent += effectiveGradient * 8.5;
            }

            motorCurrent += (baseCurrent - motorCurrent) * dt * 4.0;
            if (motorCurrent < 0) motorCurrent = 0;

        } else if (holdBrakeOn && absSpeed > 20.0) {
            currentStep = 0;
            stepTimer = 0;
            isStepping = false;

            const excessSpeed = absSpeed - 20.0;

            const baseGenCurrent = Math.max(Math.abs(gradient), 20.0) * (absSpeed / 8.0) * 15.0;
            const targetCurrent = Math.min(baseGenCurrent, 600);
            motorCurrent += (targetCurrent - motorCurrent) * dt * 4.0;

        } else {
            currentStep = 0;
            stepTimer = 0;
            isStepping = false;

            motorCurrent += (0 - motorCurrent) * dt * 5.0;
        }

        // 空気圧・エアブレーキ音処理
        const targetBc = brake * 45;
        if (bcPressure < targetBc) {
            const consumed = (targetBc - bcPressure) * dt * 2.0;
            bcPressure += consumed;
            mrPressure -= consumed * 0.6;
        } else if (bcPressure > targetBc) {
            bcPressure -= (bcPressure - targetBc) * dt * 3.0;
        }

        if (brake > 0 || Math.abs(bcPressure - targetBc) > 1.0) {
            playLoopSound('airBrake');
        } else {
            stopLoopSound('airBrake');
        }
        prevBrake = brake;

        // コンプレッサー (CP)
        if (mrPressure < 720 && !isCompressorActive && pantaOn) {
            isCompressorActive = true;
            playLoopSound('compressor');
        } else if ((mrPressure >= 850 || !pantaOn) && isCompressorActive) {
            isCompressorActive = false;
            stopLoopSound('compressor');
        }

        if (isCompressorActive) {
            mrPressure += dt * 15.0;
        }

        // ブロワー表示灯タイマー
        if (blowerTimer > 0) {
            blowerTimer -= dt;
            if (blowerTimer < 0) blowerTimer = 0;
        }

        // 進段音
        if (isStepping) {
            playLoopSound('stepping');
        } else {
            stopLoopSound('stepping');
        }

        // 物理計算
        const isPowered = canElectrify && currentStep > 0;
        const currentLimitSpeed = notchSpeedLimits[currentStep];
        let motorForce = 0;

        if (isPowered) {
            if (absSpeed < currentLimitSpeed) {
                motorForce = (motorCurrent * 0.012) * reverser;
            }
        }

        const gravityForce = (gradient / 1000) * 9.8; 
        let holdBrakeForce = 0;
        if (holdBrakeOn && absSpeed > 20.0) {
            const speedFactor = Math.min((absSpeed - 20.0) / 40.0, 1.0);
            holdBrakeForce = 3.5 * speedFactor;
        }

        const totalBrakeMag = (bcPressure / 45) * 2.5 + holdBrakeForce;
        const brakeDirection = speed > 0 ? 1 : (speed < 0 ? -1 : 0);
        let brakeForce = totalBrakeMag * brakeDirection;

        let accel = motorForce - brakeForce - (speed * 0.04) - gravityForce;

        speed += accel * dt;
        if (reverser === 0 && Math.abs(speed) < 0.1) speed = 0;

        const deltaDistance = (speed / 3.6) * dt;
        globalDistance += deltaDistance;
        if (globalDistance < 0) globalDistance = 0;

        // カメラ・ライト位置
        camera.position.copy(camPos).add(new THREE.Vector3(0, 1.8, 0));
        const lookDirection = reverser < 0 ? camDir.clone().negate() : camDir;
        const lookAtPos = camera.position.clone().add(lookDirection.multiplyScalar(10));
        camera.lookAt(lookAtPos);

        headLight.position.copy(camera.position);
        headLight.target.position.copy(lookAtPos);

        // UI 描画更新
        const nowTime = new Date();

        // 速度計
        const speedElem = document.getElementById('val-speed');
        if (speedElem) speedElem.textContent = speed.toFixed(1);
        const needleSpeed = document.getElementById('needle-speed');
        if (needleSpeed) {
            const speedAngle = -120 + Math.min(absSpeed, 100) * 2.4;
            needleSpeed.style.transform = `rotate(${speedAngle}deg)`;
        }

        // 電流計
        const displayCurrent = Math.abs(motorCurrent);
        const elemCurrent = document.getElementById('val-current');
        if (elemCurrent) elemCurrent.textContent = Math.round(displayCurrent);
        const needleCurrent = document.getElementById('needle-current');
        if (needleCurrent) {
            const currentAngle = -120 + Math.min(displayCurrent, 1000) * 0.24;
            needleCurrent.style.transform = `rotate(${currentAngle}deg)`;
        }

        // 空気圧力計 (BC/MR)
        const elemBc = document.getElementById('val-bc');
        if (elemBc) elemBc.textContent = Math.round(bcPressure);
        const elemMr = document.getElementById('val-mr');
        if (elemMr) elemMr.textContent = Math.round(mrPressure);

        const needleBc = document.getElementById('needle-bc');
        if (needleBc) {
            const bcAngle = -120 + Math.min(bcPressure, 500) * 0.48;
            needleBc.style.transform = `rotate(${bcAngle}deg)`;
        }
        const needleMr = document.getElementById('needle-mr');
        if (needleMr) {
            const mrAngle = -120 + Math.min(mrPressure, 1000) * 0.24;
            needleMr.style.transform = `rotate(${mrAngle}deg)`;
        }

        // 時計
        const hours = nowTime.getHours() % 12;
        const minutes = nowTime.getMinutes();
        const seconds = nowTime.getSeconds() + nowTime.getMilliseconds() / 1000;

        const timeElem = document.getElementById('val-time');
        if (timeElem) timeElem.textContent = nowTime.toTimeString().split(' ')[0].substring(0, 5);
        updateEnvironmentByTime(nowTime.getHours(), minutes);

        /*const needleHour = document.getElementById('needle-clock-hour');
        if (needleHour) {
            needleHour.style.transform = `rotate(${((hours + minutes / 60) / 12) * 360 - 180}deg)`;
        }

        const needleMinute = document.getElementById('needle-clock-minute');
        if (needleMinute) {
            needleMinute.style.transform = `rotate(${((minutes + seconds / 60) / 60) * 360 - 180}deg)`;
        }

        const needleSecond = document.getElementById('needle-clock-second');
        if (needleSecond) {
            needleSecond.style.transform = `rotate(${(seconds / 60) * 360 - 180}deg)`;
        }
        */

        // 表示灯
        const elemStepping = document.getElementById('indicator-stepping');
        if (elemStepping) {
            if (isStepping) {
                elemStepping.style.backgroundColor = '#ffaa00';
                elemStepping.style.color = '#000';
                elemStepping.style.boxShadow = '0 0 10px #ffaa00';
            } else {
                elemStepping.style.backgroundColor = '#222';
                elemStepping.style.color = '#555';
                elemStepping.style.boxShadow = 'none';
            }
        }

        const elemBlower = document.getElementById('indicator-blower');
        if (elemBlower) {
            if (blowerTimer > 0) {
                elemBlower.style.backgroundColor = '#ff0000';
                elemBlower.style.color = '#fff';
                elemBlower.style.boxShadow = '0 0 10px #ff0000';
            } else {
                elemBlower.style.backgroundColor = '#222';
                elemBlower.style.color = '#555';
                elemBlower.style.boxShadow = 'none';
            }
        }

        renderer.render(scene, camera);
        requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
});
