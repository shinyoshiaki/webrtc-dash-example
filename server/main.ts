import {
  AvBufferCallback,
  DepacketizeCallback,
  JitterBufferCallback,
  PromiseQueue,
  RTCPeerConnection,
  RtpSourceCallback,
  WebmCallback,
} from "werift";
import { Server } from "ws";
import { createServer } from "http";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "fs/promises";
import path from "path";
import { MPD } from "./mpd";

const dir = "./dash";
const dashServerPort = 8125;
const signalingServerPort = 8888;

const signalingServer = new Server({ port: signalingServerPort });
signalingServer.on("connection", async (socket) => {
  const { audio, video } = await recorder();

  const pc = new RTCPeerConnection();
  {
    pc.addTransceiver("audio", { direction: "recvonly" }).onTrack.subscribe(
      (track) => {
        track.onReceiveRtp.subscribe((rtp) => {
          audio.input(rtp);
        });
      }
    );
  }
  {
    pc.addTransceiver("video", { direction: "recvonly" }).onTrack.subscribe(
      (track, transceiver) => {
        track.onReceiveRtp.subscribe((rtp) => {
          video.input(rtp);
        });
        setInterval(() => {
          transceiver.receiver.sendRtcpPLI(track.ssrc!);
        }, 5_000);
      }
    );
  }

  const sdp = await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify(sdp));

  socket.on("message", (data: any) => {
    const obj = JSON.parse(data);
    if (obj.sdp) {
      pc.setRemoteDescription(obj);
    }
  });
});

async function recorder() {
  await rm(dir, { recursive: true }).catch((e) => e);
  await mkdir(dir).catch((e) => e);

  await writeFile(dir + "/dash.mpd", mpd.build());

  const avBuffer = new AvBufferCallback();
  const webm = new WebmCallback(
    [
      {
        kind: "audio",
        codec: "OPUS",
        clockRate: 48000,
        trackNumber: 1,
      },
      {
        width: 640,
        height: 480,
        kind: "video",
        codec: "VP8",
        clockRate: 90000,
        trackNumber: 2,
      },
    ],
    { duration: 1000 * 60 * 60 * 24, strictTimestamp: true }
  );

  const audio = new RtpSourceCallback();
  const video = new RtpSourceCallback();

  {
    const jitterBuffer = new JitterBufferCallback(48000);
    const depacketizer = new DepacketizeCallback("opus");

    audio.pipe((input) => jitterBuffer.input(input));
    jitterBuffer.pipe(depacketizer.input);
    depacketizer.pipe(avBuffer.inputAudio);
    avBuffer.pipeAudio(webm.inputAudio);
  }
  {
    const jitterBuffer = new JitterBufferCallback(90000);
    const depacketizer = new DepacketizeCallback("vp8", {
      isFinalPacketInSequence: (h) => h.marker,
    });

    video.pipe((input) => jitterBuffer.input(input));
    jitterBuffer.pipe(depacketizer.input);
    depacketizer.pipe(avBuffer.inputVideo);
    avBuffer.pipeVideo(webm.inputVideo);
  }

  let timestamp = 0;
  const queue = new PromiseQueue();
  webm.pipe(async (value) => {
    queue.push(async () => {
      if (value.saveToFile && value.kind) {
        switch (value.kind) {
          case "initial":
            {
              await writeFile(dir + "/init.webm", value.saveToFile);
            }
            break;
          case "cluster":
            {
              if (value.previousDuration! > 0) {
                mpd.segmentationTimeLine.push({
                  d: value.previousDuration!,
                  t: timestamp,
                });
                await writeFile(dir + "/dash.mpd", mpd.build());
                await rename(
                  dir + "/cluster.webm",
                  dir + `/media${timestamp}.webm`
                );
                timestamp += value.previousDuration!;
              }
              await writeFile(dir + `/cluster.webm`, value.saveToFile);
            }
            break;
          case "block":
            {
              await appendFile(dir + `/cluster.webm`, value.saveToFile);
            }
            break;
        }
      }
    });
  });

  return { audio, video };
}

const mpd = new MPD({
  codecs: ["vp8", "opus"],
  minBufferTime: 5,
  minimumUpdatePeriod: 1,
});

const dashServer = createServer();
dashServer.on("request", async (req, res) => {
  const filePath = dir + req.url;

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = { ".mpd": "application/dash+xml", ".webm": "video/webm" };

  if (extname === ".mpd") {
    await writeFile(dir + "/dash.mpd", mpd.build());
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Request-Method", "*");
  res.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "*");

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname] });
    res.end(file);
  } catch (error) {
    res.writeHead(404);
    res.end();
  }
});
dashServer.listen(dashServerPort);
