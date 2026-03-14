import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, FastForward, Upload, Activity, ShieldAlert, 
  Map as MapIcon, Database, Info, AlertTriangle, CheckCircle2, Navigation
} from 'lucide-react';

// --- UTILITY & MATH FUNCTIONS ---

// Haversine distance in nautical miles
const calculateDistanceNM = (lat1, lon1, lat2, lon2) => {
  const R = 3440.065; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// Predict next position based on Dead Reckoning (Linear Regression / Kinematics)
const predictPosition = (lat, lon, sog, cog, timeDiffHours) => {
  if (!sog || sog === 0) return { lat, lon };
  const distanceNm = sog * timeDiffHours;
  const R = 3440.065;
  const brng = cog * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;

  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(distanceNm/R) + Math.cos(lat1)*Math.sin(distanceNm/R)*Math.cos(brng));
  let lon2 = lon1 + Math.atan2(Math.sin(brng)*Math.sin(distanceNm/R)*Math.cos(lat1), Math.cos(distanceNm/R)-Math.sin(lat1)*Math.sin(lat2));
  
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
};

export default function App() {
  // --- STATE ---
  const [dataQueue, setDataQueue] = useState([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [vessels, setVessels] = useState(new Map());
  const [isPlaying, setIsPlaying] = useState(false);
  const [processingSpeed, setProcessingSpeed] = useState(5); // records processed per tick
  
  // Statistics State
  const [stats, setStats] = useState({
    processedCount: 0,
    deduplicatedCount: 0,
    anomaliesDetected: 0,
    dataRepaired: 0,
    packetLossRatio: 0,
    expectedPackets: 0,
    receivedPackets: 0
  });

  const [logs, setLogs] = useState([]);
  const canvasRef = useRef(null);

  // --- CSV PARSING ---
  const parseCSV = (csvText) => {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(';');
    const getIndex = (name) => headers.indexOf(name);
    
    const parsed = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      
      // Basic split handling the specific semicolon delimiter
      const row = lines[i].split(';'); 
      if (row.length < 15) continue;

      // Clean the heavily quoted strings from the raw data
      const cleanStr = (str) => {
        if (!str) return '';
        return str.replace(/^"+|"+$/g, '').replace(/""/g, '"');
      };
      
      const rawDate = cleanStr(row[getIndex('created_at')]);
      const timestamp = new Date(rawDate).getTime() || (Date.now() + i * 1000);

      parsed.push({
        id: i,
        mmsi: cleanStr(row[getIndex('mmsi')]),
        lat: parseFloat(cleanStr(row[getIndex('lat')])),
        lon: parseFloat(cleanStr(row[getIndex('lon')])),
        sog: parseFloat(cleanStr(row[getIndex('sog')])) || 0.1, // Give a default tiny speed to prevent NaN
        cog: parseFloat(cleanStr(row[getIndex('cog')])) || 0,
        timestamp: timestamp,
        rawDate: rawDate
      });
    }
    
    // Simulating Step 3: Sequencing (Sorting by Event-Time)
    return parsed.sort((a, b) => a.timestamp - b.timestamp);
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    setIsPlaying(false);
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const parsedData = parseCSV(e.target.result);
      setDataQueue(parsedData);
      setTotalRecords(parsedData.length);
      setVessels(new Map());
      setStats({
        processedCount: 0, deduplicatedCount: 0, anomaliesDetected: 0, dataRepaired: 0,
        packetLossRatio: 0, expectedPackets: 0, receivedPackets: 0
      });
      setLogs([{ time: new Date().toLocaleTimeString(), type: 'info', msg: `Successfully loaded & sequenced ${parsedData.length} AIS records.` }]);
    };
    reader.readAsText(file);
  };

  // --- STREAM PROCESSING ENGINE ---
  useEffect(() => {
    if (!isPlaying || dataQueue.length === 0) return;

    const tick = setInterval(() => {
      setDataQueue(prevQueue => {
        if (prevQueue.length === 0) {
          setIsPlaying(false);
          setLogs(l => [{ time: new Date().toLocaleTimeString(), type: 'info', msg: `Stream processing complete.` }, ...l]);
          return prevQueue;
        }

        const chunk = prevQueue.slice(0, processingSpeed);
        const remaining = prevQueue.slice(processingSpeed);
        
        setVessels(prevMap => {
          const nextMap = new Map(prevMap);
          let newStats = { ...stats };
          let newLogs = [...logs];

          chunk.forEach(packet => {
            newStats.processedCount++;
            
            const vState = nextMap.get(packet.mmsi) || {
              mmsi: packet.mmsi,
              history: [],
              lastUpdate: null,
              color: `hsl(${(parseInt(packet.mmsi) % 360) || Math.random() * 360}, 70%, 50%)`,
              status: 'normal'
            };

            // Step 2: Deduplication (Check exact timestamp overlap)
            if (vState.lastUpdate === packet.timestamp) {
              newStats.deduplicatedCount++;
              return; 
            }

            // Step 7: Packet Loss Estimation (Assuming 10s broadcast rate for moving vessels)
            if (vState.lastUpdate) {
              const timeDiffSec = (packet.timestamp - vState.lastUpdate) / 1000;
              const expectedInterval = 10; 
              const expected = Math.max(1, Math.floor(timeDiffSec / expectedInterval));
              newStats.expectedPackets += expected;
              newStats.receivedPackets += 1;
            } else {
              newStats.expectedPackets += 1;
              newStats.receivedPackets += 1;
            }

            let finalLat = packet.lat;
            let finalLon = packet.lon;
            let isRepaired = false;

            // Step 4 & 5: Abnormal Data Identification & Repair
            if (vState.history.length > 0) {
              const prev = vState.history[vState.history.length - 1];
              const timeDiffHours = (packet.timestamp - prev.timestamp) / (1000 * 3600);
              
              if (timeDiffHours > 0) {
                const distance = calculateDistanceNM(prev.lat, prev.lon, packet.lat, packet.lon);
                const impliedSpeed = distance / timeDiffHours;

                // Rule-based Kinematic Check: Implied speed > 60 knots or boundary error
                if (impliedSpeed > 60 || packet.lat > 90 || packet.lat < -90 || packet.lon > 180 || packet.lon < -180) {
                  newStats.anomaliesDetected++;
                  newLogs.unshift({
                    time: packet.rawDate || new Date(packet.timestamp).toLocaleTimeString(),
                    type: 'anomaly',
                    msg: `MMSI ${packet.mmsi}: Spatial anomaly! Implied speed ${impliedSpeed.toFixed(1)} kn > 60 kn.`
                  });

                  // Step 5: Linear Regression / Dead Reckoning Repair
                  const repairedPos = predictPosition(prev.lat, prev.lon, prev.sog || packet.sog, prev.cog || packet.cog, timeDiffHours);
                  finalLat = repairedPos.lat;
                  finalLon = repairedPos.lon;
                  isRepaired = true;
                  newStats.dataRepaired++;
                  vState.status = 'repaired';
                  
                  newLogs.unshift({
                    time: packet.rawDate || new Date(packet.timestamp).toLocaleTimeString(),
                    type: 'repair',
                    msg: `MMSI ${packet.mmsi}: Trajectory repaired using linear interpolation.`
                  });
                } else {
                  vState.status = 'normal';
                }
              }
            }

            // Step 6: Prediction (Predicting next 5 minutes location)
            const prediction = predictPosition(finalLat, finalLon, packet.sog, packet.cog, 5 / 60);

            // Commit Update to state
            vState.history.push({
              lat: finalLat,
              lon: finalLon,
              sog: packet.sog,
              cog: packet.cog,
              timestamp: packet.timestamp,
              repaired: isRepaired
            });
            
            // Limit history length to avoid memory leak in browser
            if (vState.history.length > 50) vState.history.shift();

            vState.lastUpdate = packet.timestamp;
            vState.prediction = prediction;
            nextMap.set(packet.mmsi, vState);
          });

          // Calculate overall Packet Loss Ratio
          if (newStats.expectedPackets > 0) {
            let ratio = ((1 - (newStats.receivedPackets / newStats.expectedPackets)) * 100);
            if (ratio < 0) ratio = 0;
            if (ratio > 100) ratio = 100;
            newStats.packetLossRatio = ratio.toFixed(1);
          }

          setStats(newStats);
          if (newLogs.length > 40) newLogs = newLogs.slice(0, 40); 
          setLogs(newLogs);
          
          return nextMap;
        });

        return remaining;
      });
    }, 100); // 100ms streaming tick

    return () => clearInterval(tick);
  }, [isPlaying, processingSpeed, stats, logs]);

  // --- SPATIAL-TEMPORAL VISUALIZATION (CANVAS) ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Background
    ctx.fillStyle = '#0f172a'; // tailwind slate-900
    ctx.fillRect(0, 0, width, height);

    if (vessels.size === 0) return;

    // Dynamic Viewport Auto-Scaling
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    vessels.forEach(v => {
      v.history.forEach(p => {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      });
    });

    // Handle single point or very tight cluster scaling
    const latDiff = maxLat - minLat;
    const lonDiff = maxLon - minLon;
    const latPad = latDiff === 0 ? 0.05 : latDiff * 0.2;
    const lonPad = lonDiff === 0 ? 0.05 : lonDiff * 0.2;
    
    minLat -= latPad; maxLat += latPad;
    minLon -= lonPad; maxLon += lonPad;

    const mapX = (lon) => ((lon - minLon) / (maxLon - minLon)) * width;
    const mapY = (lat) => height - (((lat - minLat) / (maxLat - minLat)) * height);

    // Draw Map Grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (let i = 0; i < 10; i++) {
      ctx.beginPath(); ctx.moveTo(0, height * (i/10)); ctx.lineTo(width, height * (i/10)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(width * (i/10), 0); ctx.lineTo(width * (i/10), height); ctx.stroke();
    }

    // Draw Vessels
    vessels.forEach((vessel) => {
      if (vessel.history.length === 0) return;

      // 1. Draw Trajectory Line
      ctx.beginPath();
      vessel.history.forEach((pt, i) => {
        const x = mapX(pt.lon);
        const y = mapY(pt.lat);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = vessel.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      // 2. Draw Historical Points
      vessel.history.forEach(pt => {
        ctx.beginPath();
        ctx.arc(mapX(pt.lon), mapY(pt.lat), pt.repaired ? 4 : 2, 0, 2 * Math.PI);
        ctx.fillStyle = pt.repaired ? '#ef4444' : vessel.color; // Red for repaired anomalies
        ctx.fill();
      });

      // 3. Current Position Arrow/Indicator
      const current = vessel.history[vessel.history.length - 1];
      const cx = mapX(current.lon);
      const cy = mapY(current.lat);
      
      if (vessel.status === 'repaired') {
        ctx.beginPath();
        ctx.arc(cx, cy, 15, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // 4. Draw Prediction Vector (Dead Reckoning)
      if (vessel.prediction) {
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.moveTo(cx, cy);
        ctx.lineTo(mapX(vessel.prediction.lon), mapY(vessel.prediction.lat));
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 5. MMSI Label
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '10px monospace';
      ctx.fillText(vessel.mmsi, cx + 8, cy + 3);
    });

  }, [vessels]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded">
            <Navigation className="text-white" size={20} />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Maritime AIS Stream Processor</h1>
            <p className="text-xs text-slate-400">Distributed Architecture Simulation</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 bg-slate-800 border border-slate-700 hover:bg-slate-700 px-4 py-2 rounded-md cursor-pointer transition text-sm">
            <Upload size={16} />
            <span>Upload Dataset (.csv)</span>
            <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Left Control Panel */}
        <aside className="w-80 bg-slate-900 border-r border-slate-800 flex flex-col p-5 overflow-y-auto">
          
          {/* Stream Controls */}
          <div className="mb-8">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Pipeline Controls</h2>
            <button 
              onClick={() => setIsPlaying(!isPlaying)}
              disabled={dataQueue.length === 0 && totalRecords === 0}
              className={`w-full flex justify-center items-center gap-2 py-3 rounded-md font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${
                isPlaying ? 'bg-amber-500/10 text-amber-500 border border-amber-500/50 hover:bg-amber-500/20' 
                          : 'bg-blue-600 text-white hover:bg-blue-500'
              }`}
            >
              {isPlaying ? <><Pause size={18}/> Suspend Stream</> : <><Play size={18}/> Execute Engine</>}
            </button>
            
            <div className="bg-slate-950 p-4 rounded-md mt-4 border border-slate-800">
              <div className="flex justify-between text-xs mb-2 text-slate-400">
                <span>Ingestion Velocity:</span>
                <span className="font-mono text-blue-400 font-bold">{processingSpeed} msgs/tick</span>
              </div>
              <input 
                type="range" min="1" max="100" value={processingSpeed} 
                onChange={(e) => setProcessingSpeed(Number(e.target.value))}
                className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-slate-500 mt-3 font-mono">
                <span>Total: {totalRecords}</span>
                <span>Queue: {dataQueue.length}</span>
              </div>
            </div>
          </div>

          {/* Real-time Analytics */}
          <div className="mb-8">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Activity size={14}/> Multifactor Statistics
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-950 p-3 rounded-md border border-slate-800">
                <div className="text-[10px] text-slate-400 mb-1 uppercase tracking-wide">Processed</div>
                <div className="text-lg font-mono text-white">{stats.processedCount}</div>
              </div>
              <div className="bg-slate-950 p-3 rounded-md border border-slate-800">
                <div className="text-[10px] text-slate-400 mb-1 uppercase tracking-wide">Tracked Vessels</div>
                <div className="text-lg font-mono text-blue-400">{vessels.size}</div>
              </div>
              <div className="bg-slate-950 p-3 rounded-md border border-slate-800">
                <div className="text-[10px] text-slate-400 mb-1 uppercase tracking-wide">Deduplicated</div>
                <div className="text-lg font-mono text-slate-300">{stats.deduplicatedCount}</div>
              </div>
              <div className="bg-slate-950 p-3 rounded-md border border-slate-800">
                <div className="text-[10px] text-slate-400 mb-1 uppercase tracking-wide">Packet Loss</div>
                <div className="text-lg font-mono text-amber-400">{stats.packetLossRatio}%</div>
              </div>
            </div>
          </div>

          {/* Data Cleaning Module */}
          <div>
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <ShieldAlert size={14}/> Data Cleaning Status
            </h2>
            <div className="space-y-3">
              <div className="flex justify-between items-center bg-slate-950 p-3 rounded-md border border-amber-900/50">
                <span className="text-xs text-slate-300">Anomalies Detected</span>
                <span className="font-mono text-amber-500 font-bold">{stats.anomaliesDetected}</span>
              </div>
              <div className="flex justify-between items-center bg-slate-950 p-3 rounded-md border border-green-900/50">
                <span className="text-xs text-slate-300">LinReg Repaired</span>
                <span className="font-mono text-green-500 font-bold">{stats.dataRepaired}</span>
              </div>
            </div>
          </div>

        </aside>

        {/* Center Canvas & Console */}
        <main className="flex-1 flex flex-col relative bg-[#0f172a]">
          
          {/* Map Overlay/Legend */}
          <div className="absolute top-4 right-4 bg-slate-900/90 backdrop-blur border border-slate-700 p-4 rounded-md shadow-xl z-10 text-xs text-slate-300 space-y-3">
            <div className="font-bold text-white mb-1 border-b border-slate-700 pb-2">Spatial Visualization Legend</div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-white outline outline-2 outline-offset-2 outline-slate-600"></div> 
              Current Vessel State
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-0 border-t-2 border-dashed border-blue-500"></div> 
              Predicted Vector (5min DR)
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-red-500 opacity-80"></div> 
              Repaired Anomaly (Linear Interpolation)
            </div>
          </div>

          {/* HTML5 Map Canvas */}
          <div className="flex-1 w-full h-full relative">
            {vessels.size === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-600 flex-col gap-4">
                <MapIcon size={64} opacity={0.3} />
                <p className="text-sm">Engine Idle. Please upload the raw AIS export CSV.</p>
              </div>
            )}
            <canvas 
              ref={canvasRef} 
              width={1200} 
              height={800} 
              className="w-full h-full object-contain mix-blend-screen"
            />
          </div>

          {/* System Console */}
          <div className="h-56 bg-slate-950 border-t border-slate-800 flex flex-col font-mono">
            <div className="p-3 border-b border-slate-900 flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest bg-slate-900">
              <Database size={12} /> Live Event Stream Log
            </div>
            <div className="flex-1 overflow-y-auto p-3 text-[11px] space-y-2">
              {logs.length === 0 ? (
                <div className="text-slate-700 h-full flex items-center justify-center italic">Awaiting event stream...</div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="flex gap-3 leading-relaxed hover:bg-slate-900/50 p-1 rounded transition-colors">
                    <span className="text-slate-600 w-24 flex-shrink-0">[{log.time}]</span>
                    <span className="flex-shrink-0 mt-0.5">
                      {log.type === 'anomaly' && <AlertTriangle size={12} className="text-amber-500" />}
                      {log.type === 'repair' && <CheckCircle2 size={12} className="text-green-500" />}
                      {log.type === 'info' && <Info size={12} className="text-blue-500" />}
                    </span>
                    <span className={`
                      ${log.type === 'anomaly' ? 'text-amber-400' : ''}
                      ${log.type === 'repair' ? 'text-green-400' : ''}
                      ${log.type === 'info' ? 'text-blue-300' : 'text-slate-300'}
                    `}>
                      {log.msg}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

        </main>
      </div>
    </div>
  );
}