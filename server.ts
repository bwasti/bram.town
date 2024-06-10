import { createServer, Socket } from "net";
import { EventEmitter } from "events";

// Telnet negotiation commands
const IAC = 255; // Interpret as Command
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250; // Subnegotiation
const SE = 240; // End Subnegotiation

// Telnet options
const ECHO = 1;
const SUPPRESS_GO_AHEAD = 3;
const LINEMODE = 34;
const MODE = 1; // Mode sub-option
const NAWS = 31; // Negotiate About Window Size

// 10 seconds
const INACTIVITY_TIMEOUT = parseInt(process.env.INACTIVITY_TIMEOUT) || 10000;
const MAX_USERS = parseInt(process.env.MAX_USERS) || 100;

let userCounter = 0;
const gridSize = 1024;
const globalGrid = new Uint8Array(gridSize * gridSize);
// Function to set a value in the global grid
function setGridValue(y: number, x: number, value: number) {
  globalGrid[y * gridSize + x] = value;
  let k = 0;
  for (let i of globalGrid) {
    k += i;
  }
}

// Function to get a value from the global grid
function getGridValue(y: number, x: number): number {
  return globalGrid[y * gridSize + x];
}

interface User {
  id: string;
  socket: Socket;
  x: number;
  y: number;
  z: number; // zoom
  cursor_x: number;
  cursor_y: number;
  width: number;
  height: number;
  lastRenderTime: number;
  renderTimer: NodeJS.Timeout | null;
  events: EventEmitter;
  inactivityTimer: NodeJS.Timeout | null;
  previousRender: string;
}

const users: User[] = [];

const negotiate = (socket: Socket) => {
  // Disable echo
  socket.write(Buffer.from([IAC, WILL, ECHO]));
  // Disable line mode and enable character mode
  socket.write(Buffer.from([IAC, DONT, LINEMODE]));
  // Request window size
  socket.write(Buffer.from([IAC, DO, NAWS]));
  // Suppress go-ahead
  socket.write(Buffer.from([IAC, WILL, SUPPRESS_GO_AHEAD]));
  socket.write(Buffer.from([IAC, DO, SUPPRESS_GO_AHEAD]));
  // https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
  socket.write("\x1b[?1003;1006;1015h"); // Enable all mouse tracking
};

function handleNAWS(data: number[], user: User) {
  if (data.length >= 5) {
    user.width = (data[0] << 8) + data[1];
    user.height = (data[2] << 8) + data[3];
    //scheduleRender(user);
  }
}

function resetInactivityTimer(user: User) {
  if (user.inactivityTimer) {
    clearTimeout(user.inactivityTimer);
  }
  user.inactivityTimer = setTimeout(() => {
    console.log(`${user.id} disconnected due to inactivity.`);
    killUser(user, "disconnected due to inactivity.");
  }, INACTIVITY_TIMEOUT);
}

// Character mapping
const luminosityChars = [" ", ".", "-", "+", "*", "#", "@"];

// Function to render a section of the grid for a user
function renderGridForUser(user: User): string {
  const endX = Math.min(user.x + user.width, gridSize);
  const endY = Math.min(user.y + user.height, gridSize);

  let result = "";
  let userCursors = {};
  for (let user of users) {
    userCursors[user.cursor_y * gridSize + user.cursor_x] = user;
  }

  for (let y = user.y; y < endY; y++) {
    for (let x = user.x; x < endX; x++) {
      const v = y * gridSize + x;
      if (v in userCursors) {
        result += "⊙";
      } else {
        result += luminosityChars[getGridValue(y, x)];
      }
    }
  }

  return result;
}

const renderScreen = (user: User) => {
  const screenString = renderGridForUser(user);
  const currentRender = [];

  for (let i = 0; i < screenString.length; i += user.width) {
    currentRender.push(screenString.slice(i, i + user.width));
  }

  if (
    !user.previousRender ||
    user.previousRender.length !== screenString.length
  ) {
    // Fallback to sending the entire frame if the length has changed
    user.socket.write("\x1b[H"); // Move cursor to the top-left corner
    user.socket.write(screenString + "\x1b[?25l"); // Hide the cursor
  } else {
    // Calculate and send deltas
    const previousLines = [];
    for (let i = 0; i < user.previousRender.length; i += user.width) {
      previousLines.push(user.previousRender.slice(i, i + user.width));
    }

    currentRender.forEach((line, index) => {
      if (previousLines[index] !== line) {
        user.socket.write(`\x1b[${index + 1};1H`); // Move cursor to the line
        user.socket.write(line);
      }
    });
  }

  user.socket.write("\x1b[H");
  user.socket.write("you can draw! (hit 'q' to exit)" + "\x1b[?25l");

  // Update previous render
  user.previousRender = screenString;
};

const scheduleRender = (user: User) => {
  const now = Date.now();
  const timeSinceLastRender = now - user.lastRenderTime;
  const renderInterval = 100; // 20 fps = 1000ms / 20 = 50ms

  if (timeSinceLastRender >= renderInterval) {
    user.lastRenderTime = now;
    renderScreen(user);
  } else if (!user.renderTimer) {
    user.renderTimer = setTimeout(() => {
      user.lastRenderTime = Date.now();
      renderScreen(user);
      user.renderTimer = null;
    }, renderInterval - timeSinceLastRender);
  }
};

type MouseEventType = "click" | "move" | "scroll";
interface MouseEvent {
  type: MouseEventType;
  button: number;
  x: number;
  y: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

function parseXtermMouseInput(buffer: number[]): MouseEvent | null {
  if (buffer.length < 9 || buffer[0] !== 27 || buffer[1] !== 91) {
    return null;
  }

  // Determine if the event is in the new format
  const isNewFormat = buffer[buffer.length - 1] === 77;
  if (!isNewFormat) {
    return null;
  }

  const parts = String.fromCharCode(
    ...buffer.slice(2, buffer.length - 1),
  ).split(";");

  if (parts.length < 3) {
    return null;
  }

  // Extract the event type and modifier byte
  const eventByte = parseInt(parts[0], 10) - 32;
  const button = eventByte & 3; // button info (0: left, 1: middle, 2: right, 3: release)
  const shift = !!(eventByte & 4);
  const meta = !!(eventByte & 8);
  const ctrl = !!(eventByte & 16);

  let eventType: MouseEventType;
  if ((eventByte & 64) === 64) {
    eventType = "scroll";
  } else if ((eventByte & 32) === 32) {
    eventType = "move";
  } else {
    eventType = "click";
  }

  // Extract X and Y coordinates
  const x = parseInt(parts[1], 10) - 1;
  const y = parseInt(parts[2], 10) - 1;

  return {
    type: eventType,
    button,
    x,
    y,
    shift,
    meta,
    ctrl,
  };
}

type KeyEventType = "character" | "arrow";
interface KeyEvent {
  type: KeyEventType;
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

function parseKeyInput(buffer: number[]): KeyEvent | null {
  if (buffer.length === 0) {
    return null;
  }

  // Handle escape sequences for arrow keys
  if (buffer[0] === 27 && buffer[1] === 91) {
    if (buffer[2] === 65) {
      return {
        type: "arrow",
        key: "up",
        ctrl: false,
        meta: false,
        shift: false,
      };
    }
    if (buffer[2] === 66) {
      return {
        type: "arrow",
        key: "down",
        ctrl: false,
        meta: false,
        shift: false,
      };
    }
    if (buffer[2] === 67) {
      return {
        type: "arrow",
        key: "right",
        ctrl: false,
        meta: false,
        shift: false,
      };
    }
    if (buffer[2] === 68) {
      return {
        type: "arrow",
        key: "left",
        ctrl: false,
        meta: false,
        shift: false,
      };
    }
  }

  // Handle regular characters
  const char = String.fromCharCode(buffer[0]);
  return {
    type: "character",
    key: char,
    ctrl: false,
    meta: false,
    shift: false,
  };
}

type TelnetCommandType = "DO" | "DONT" | "WILL" | "WONT" | "SB" | "SE" | "IAC";
interface TelnetCommand {
  command: TelnetCommandType;
  option?: number;
  data?: number[];
}

function killUser(user: User, msg: string) {
  user.socket.write("\x1b[?1003;1006;1015l"); // Disable all mouse tracking
  user.socket.write("\x1b[H");
  user.socket.write(msg + " bye! " + "\x1b[?25h");
  user.socket.end();
}

function parseTelnetNegotiation(buffer: number[]): TelnetCommand[] {
  const commands: TelnetCommand[] = [];
  let i = 0;

  while (i < buffer.length) {
    if (buffer[i] === 255) {
      // IAC
      const commandByte = buffer[i + 1];
      let command: TelnetCommandType;
      let option: number | undefined;
      let data: number[] | undefined;

      switch (commandByte) {
        case 253:
          command = "DO";
          option = buffer[i + 2];
          i += 3;
          break;
        case 254:
          command = "DONT";
          option = buffer[i + 2];
          i += 3;
          break;
        case 251:
          command = "WILL";
          option = buffer[i + 2];
          i += 3;
          break;
        case 252:
          command = "WONT";
          option = buffer[i + 2];
          i += 3;
          break;
        case 250:
          command = "SB";
          option = buffer[i + 2];
          data = [];
          i += 3;
          while (i < buffer.length && buffer[i] !== 240) {
            // SE
            data.push(buffer[i]);
            i++;
          }
          i++; // Skip SE
          break;
        case 240:
          command = "SE";
          i += 2;
          break;
        default:
          command = "IAC";
          i += 2;
          break;
      }

      commands.push({ command, option, data });
    } else {
      i++;
    }
  }

  return commands;
}

const handleSocket = async (socket: Socket) => {
  userCounter += 1;
  const userId = `User${userCounter}`;

  const user: User = {
    id: userId,
    socket,
    x: Math.floor(gridSize / 2),
    y: Math.floor(gridSize / 2),
    zoom: 0,
    cursor_x: Math.floor(gridSize / 2),
    cursor_y: Math.floor(gridSize / 2),
    width: 80,
    height: 24,
    lastRenderTime: 0,
    renderTimer: null,
    events: new EventEmitter(),
    inactivityTimer: null,
    previousRender: "",
  };

  if (users.length >= MAX_USERS) {
    killUser(user, "too many users connected, please try again later.");
  }
  resetInactivityTimer(user);

  user.events.on("scroll", (ev) => {
    if (ev.button === 0) {
      user.zoom = Math.max(user.zoom - 1, 0);
    } else {
      user.zoom = Math.min(user.zoom + 1, 10);
    }
    scheduleRender(user);
  });
  user.events.on("mousemove", (ev) => {
    const x = user.x + ev.x;
    const y = user.y + ev.y;
    user.cursor_x = x;
    user.cursor_y = y;
    broadcastRender();
  });
  const drawEvent = (ev) => {
    const x = user.x + ev.x;
    const y = user.y + ev.y;
    const newVal = globalGrid[y * gridSize + x] + (ev.shift ? -1 : 1);
    globalGrid[y * gridSize + x] = Math.max(
      Math.min(newVal, luminosityChars.length - 1),
      0,
    );
    broadcastRender();
  };
  user.events.on("mousedrag", drawEvent);
  user.events.on("mouseclick", drawEvent);

  user.events.on("arrowkey", (ev) => {
    if (ev.key === "up") {
      user.y = Math.max(user.y - 1, 0);
    } else if (ev.key === "down") {
      user.y = Math.min(user.y + 1, gridSize);
    } else if (ev.key === "left") {
      user.x = Math.max(user.x - 2, 0);
    } else if (ev.key === "right") {
      user.x = Math.min(user.x + 2, gridSize);
    }
    broadcastRender();
  });

  user.events.on("keypress", (ev) => {
    if (ev.key === "q") {
      console.log(`${user.id} disconnected due to 'q' key press.`);
      killUser(user, "you hit 'q'.");
    }
    if (ev.key === "w") {
      user.y = Math.max(user.y - 1, 0);
    } else if (ev.key === "s") {
      user.y = Math.min(user.y + 1, gridSize);
    } else if (ev.key === "a") {
      user.x = Math.max(user.x - 2, 0);
    } else if (ev.key === "d") {
      user.x = Math.min(user.x + 2, gridSize);
    }
    broadcastRender();
  });

  users.push(user);
  console.log(`${user.id} connected. ${users.length} total.`);

  negotiate(socket);

  let negotiationBuffer: number[] = [];
  let inNegotiation = false;

  socket.on("data", (data: Buffer) => {
    resetInactivityTimer(user);
    const telnetEvent = parseTelnetNegotiation(data);
    if (telnetEvent.length) {
      telnetEvent.forEach((command) => {
        if (
          command.command === "SB" &&
          command.option === NAWS &&
          command.data
        ) {
          handleNAWS(command.data, user);
          scheduleRender(user);
        }
      });
      return;
    }
    const mouseEvent = parseXtermMouseInput(data);
    if (mouseEvent) {
      if (mouseEvent.type === "move") {
        if (mouseEvent.button === 0) {
          user.events.emit("mousedrag", mouseEvent);
        }
        user.events.emit("mousemove", mouseEvent);
      }
      if (mouseEvent.type === "click") {
        user.events.emit("mouseclick", mouseEvent);
      }
      if (mouseEvent.type === "scroll") {
        user.events.emit("scroll", mouseEvent);
      }
      return;
    }
    const keyEvent = parseKeyInput(data);
    if (keyEvent?.type === "arrow") {
      user.events.emit("arrowkey", keyEvent);
    }
    if (keyEvent?.type === "character") {
      user.events.emit("keypress", keyEvent);
    }
    return;
  });

  socket.on("end", () => {
    console.log(`${user.id} disconnected. ${users.length - 1} total.`);
    users.splice(users.indexOf(user), 1);
  });
};

function broadcastRender() {
  for (let user of users) {
    scheduleRender(user);
  }
}

const startServer = async () => {
  const server = createServer(handleSocket);
  const port = parseInt(process.env.PORT) || 23;

  server.listen(port, () => {
    console.log(`Telnet server listening on port ${port}`);
  });
};

startServer();
