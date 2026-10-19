# Playing G³ over long distances

On the same Wi-Fi it works out of the box: in the lobby pick **WI-FI/LAN**, one
person **HOST A ROOM**, everyone else **JOIN A ROOM → SEARCH LAN**. Rooms hold
up to 16 players (fewer for games with smaller limits). For anything farther,
pick one of the options below; chat, ready checks and the game channel work
the same over all of them.

## Over the internet

### Easiest: room code (nothing to set up)
Pick **ROOM_CODE**. The host presses **[ NEW CODE ]**, then **OPEN ROOM**, and
sends the code to friends. Each friend picks ROOM_CODE → **JOIN A ROOM**, types
the code and presses **JOIN ROOM**. Any number of friends can use one code.

Behind the scenes everybody connects *out* to free public message servers
(MQTT brokers), because home connections can't reach each other directly.
Everything is encrypted with a key made from the room code, so the servers only
carry scrambled data: use generated codes, not short ones. Public brokers are
free community services with no guarantees, and some school or office networks
block them. If it can't connect, use a relay or Tailscale.

### Option A: your own relay
You need one machine everyone can reach (a small cloud VM, or a PC whose router
forwards **TCP 47900**):

    python -m game.relay            # listens on TCP 47900

Everybody picks **RELAY**, types the relay's address (for example
`203.0.113.7` or `myrelay.example.com:47900`) and the same room code. The host
opens the room, the others join. The relay only forwards bytes between players;
it can see game messages but stores nothing. G³ remembers the address.

### Option B: a virtual LAN (no code, no server)
Install Tailscale or ZeroTier on every computer and put them in one network.
The host picks **WI-FI/LAN → HOST**; friends pick **WI-FI/LAN → JOIN** and type
the host's Tailscale/ZeroTier address (100.x.x.x). SEARCH won't find hosts this
way, but typing the address works.

### Option C: port forwarding
The host forwards **TCP 51337** on their router to their computer and shares
their public IP; friends use **WI-FI/LAN → JOIN** with it. This works but
exposes a port on the host's network, so options A or B are nicer.

## Over LoRa radio (no internet at all)

LoRa trades speed for range: kilometres with a clear line of sight, much less
through buildings. A radio room holds exactly **two** players (host + one
friend). Chat and the game channel work; the radio carries only a few kbit/s.

### What to buy (two of each)
- A **UART ("transparent serial") LoRa module** that can be set to
  **865-867 MHz**, for example the Ebyte E220-900T22D (SX1262 based, 22 dBm) or
  a Waveshare SX126x LoRa HAT used in UART mode. Get a proper antenna for the
  band, and never transmit without one attached.
- A USB-to-TTL serial adapter (CP2102 or CH340), 3.3 V logic, and `pip install pyserial`.

### Legal note (India)
The 865-867 MHz band is licence-free for low-power devices (DoT/WPC:
max 1 W transmitter power, 4 W ERP, 200 kHz carrier bandwidth). Many modules
sold as "868 MHz" default to channels **outside** that range, and 915 MHz
modules aren't allowed in India at all. **Before first use, set the channel
inside 865-867 MHz** with the module maker's configuration tool, and check the
result against the module's datasheet. G³ never changes radio settings itself.

### One-time module setup (with the maker's tool)
Use the manufacturer's configuration utility and datasheet (the module has a
configuration mode selected with its M0/M1 pins). Set the following, the same
on both modules:

- a frequency/channel inside **865-867 MHz**
- UART **9600 baud, 8N1**
- **transparent** transmission mode
- air data rate around **2.4 kbps** (lower = longer range but slower)
- packet size **200 bytes**
- transmit power within the legal limit (22 dBm modules are well under it)

Then put the module back into **normal mode** (for the E220: M0 and M1 to GND).

### Wiring
    Module VCC -> 3.3 V      Module GND -> GND
    Module TXD -> adapter RX Module RXD -> adapter TX
    Module M0, M1 -> GND (normal mode)

### Playing
Both players pick **LORA_RADIO**, choose the serial port (for example `COM5`
or `/dev/ttyUSB0`), type the same room code (this keeps you from pairing with
strangers on the same channel), then one picks **HOST A ROOM** and the other
**JOIN A ROOM**.

### Trying it without radios
On Linux/macOS, `python -m game.lora_sim` creates two pretend radio ports (it
prints their paths) that behave like a slow, lossy LoRa link. Start two copies
(`play_second_copy_mac_linux.sh` for the second), choose LORA_RADIO in each,
type one path per window, then host in one and join in the other. On Windows use
a virtual COM-port pair (for example com0com) instead.
