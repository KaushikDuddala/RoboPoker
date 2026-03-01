

import argparse
import random
import sys
import time
import select
import termios
import threading
import subprocess

import cv2
import pyttsx3
import requests
from ultralytics import YOLO

# CONFIG

DEFAULT_HOST    = "http://localhost:8080"
ROBOT_USERNAME  = "robot"
ROBOT_PASSWORD  = "robot123"
MODEL_PATH      = "model.pt"
CAM_HAND_INDEX  = 4      
CAM_BOARD_INDEX = 2   
SCAN_DURATION   = 1.0   
DECISION_DELAY  = 1.2    
POLL_INTERVAL   = 0.1   


# ARM CONFIG


ARM_PORT = "/dev/ttyACM1" 
ARM_ID   = "follower"      

ARM_GESTURES = {
    "check": ("hit2",   0),
    "call":  ("hit2",   0),
    "raise": ("hit2",   0),
    "fold":  ("stand1", 0),
    "wave":  ("flip",   0),
}

ARM_ENABLED = True

_arm_lock = threading.Lock()



# ARM


def arm_connect(port: str, robot_id: str) -> bool:
    global robot
    if not ARM_ENABLED:
        return True
    try:
        cfg = SO101FollowerConfig(port=port, id=robot_id)
        robot = SO101Follower(cfg)
        robot.connect()
        print(f"[ARM] Connected SO101 on {port} (id={robot_id})")
        return True
    except Exception as e:
        print(f"[ARM] Warning: could not connect — {e}")
        robot = None
        return False


def arm_disconnect():
    global robot
    if robot is not None:
        try:
            robot.disconnect()
            print("[ARM] Disconnected.")
        except Exception:
            pass
        robot = None


def replayEpisode(repo, episode):
    return 0
    

def bruh():
    dataset = LeRobotDataset("kaushikduddala/" + repo, episodes=[episode])
    actions = dataset.hf_dataset.select_columns("action")
    for idx in range(dataset.num_frames):
        t0 = time.perf_counter()
        action = {
            name: float(actions[idx]["action"][i]) for i, name in enumerate(dataset.features["action"]["names"])
        }
        robot.send_action(action)
        precise_sleep(1.0 / dataset.fps - (time.perf_counter() - t0))

def _arm_gesture(gesture_key: str):
    if not ARM_ENABLED:
        return
    entry = ARM_GESTURES.get(gesture_key)
    if entry is None:
        print(f"  [ARM] No gesture mapped for '{gesture_key}'")
        return
    repo, episode = entry

    cmd = (
        f"lerobot-replay "
        f"--robot.type=so101_follower "
        f"--robot.port={ARM_PORT} "
        f"--robot.id={ARM_ID} "
        f"--dataset.repo_id=KaushikDuddala/{repo} "
        f"--dataset.episode={episode}"
    )

    window_name = f"arm_{gesture_key}"
    try:
        subprocess.Popen(["tmux", "-S", "./bruh", "new-window", "-n", window_name, cmd])
        print(f"  [ARM] tmux '{window_name}' → {cmd}")
    except Exception as e:
        print(f"  [ARM] Warning: tmux launch failed — {e}")

# ARM MOVEMENT — public API

def arm_check():          _arm_gesture("check")
def arm_fold():           _arm_gesture("fold")
def arm_raise(amount):    _arm_gesture("raise")
def arm_call(amount):     _arm_gesture("call")
def arm_wave():           _arm_gesture("wave")



# VOICE LINES

VOICE_LINES = {
    "check": [
        "Check.",
        "I'll check.",
        "Checking it over.",
        "Let's see what happens.",
        "Check. Your move.",
        "I'll pass for now.",
        "Check. I'm patient.",
        "Checking. Don't get too comfortable.",
    ],
    "call": [
        "I'll call.",
        "Call.",
        "I'm in.",
        "I'll match that.",
        "Call. Let's see what you've got.",
        "Worth a look. Call.",
        "I'm not going anywhere. Call.",
    ],
    "fold": [
        "I fold.",
        "Not this time.",
        "I'm out.",
        "Folding. Discretion is the better part of valor.",
        "I'll sit this one out.",
        "Fold. Live to fight another hand.",
        "Not worth it. Fold.",
    ],
    "raise": [
        "Raise.",
        "I'm raising.",
        "Let's make this interesting.",
        "Raise. Put your chips where your mouth is.",
        "Time to turn up the heat.",
        "I raise. Think carefully.",
        "Raising. Can you keep up?",
        "All indicators say raise.",
    ],
    "new_hand": [
        "New hand. Let's go.",
        "Fresh deal. Fresh chances.",
        "Shuffling up and dealing.",
        "New hand. May the best player win.",
        "Here we go again.",
        "Next hand. Stay sharp.",
    ],
    "advance_street": [
        "Next street.",
        "Moving on.",
        "Let's see the next cards.",
        "The plot thickens.",
        "Advancing. Things are getting interesting.",
        "On to the next.",
    ],
    "hate": [
        "dumb ah idiot"
    ],
}

_tts_engine = pyttsx3.init()
_tts_engine.setProperty("rate", 165)
_tts_engine.setProperty("volume", 1.0)

def speak(action_key):
    lines = VOICE_LINES.get(action_key, [])
    if not lines:
        return
    line = random.choice(lines)
    print(f"  [VOICE] {line}")

    def _run():
        _tts_engine.say(line)
        _tts_engine.runAndWait()

    threading.Thread(target=_run, daemon=True).start()


# KEYBOARD — raw mode held open for the session


_fd       = sys.stdin.fileno()
_old_term = termios.tcgetattr(_fd)

def enable_raw():
    new = termios.tcgetattr(_fd)
    new[0] &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK |
                termios.ISTRIP | termios.INLCR | termios.IGNCR |
                termios.ICRNL | termios.IXON)
    new[1] &= ~termios.OPOST
    new[2] &= ~(termios.CSIZE | termios.PARENB)
    new[2] |= termios.CS8
    new[3] &= ~(termios.ICANON | termios.ECHO | termios.ECHOE | termios.ECHONL)
    new[6][termios.VMIN]  = 1
    new[6][termios.VTIME] = 0
    termios.tcsetattr(_fd, termios.TCSADRAIN, new)

def restore_term():
    termios.tcsetattr(_fd, termios.TCSADRAIN, _old_term)

def get_key_nonblocking():
    if select.select([sys.stdin], [], [], 0)[0]:
        return sys.stdin.read(1)
    return None


# CARD FORMAT TRANSLATION

RANK_MAP = {
    '2':'2','3':'3','4':'4','5':'5','6':'6',
    '7':'7','8':'8','9':'9','10':'T',
    'J':'J','Q':'Q','K':'K','A':'A',
}
SUIT_MAP = {'H':'h','D':'d','C':'c','S':'s'}

def yolo_to_server(label):
    label = label.strip().upper()
    suit  = label[-1]
    rank  = label[:-1]
    r = RANK_MAP.get(rank)
    s = SUIT_MAP.get(suit)
    return f"{r}{s}" if r and s else None


# POKER MATH

CARD_VALUES = {
    '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,
    '9':9,'T':10,'J':11,'Q':12,'K':13,'A':14,
}

def card_rank(c): return CARD_VALUES.get(c[0], 0)
def card_suit(c): return c[1]

def evaluate_hand(cards):
    from itertools import combinations

    def score_five(five):
        values = sorted([card_rank(c) for c in five], reverse=True)
        suits  = [card_suit(c) for c in five]
        counts = {}
        for v in values:
            counts[v] = counts.get(v, 0) + 1
        freq     = sorted(counts.values(), reverse=True)
        is_flush = len(set(suits)) == 1
        sv       = sorted(set(values))
        is_str   = len(sv) == 5 and sv[-1] - sv[0] == 4
        if set(values) == {14,2,3,4,5}:
            is_str, values = True, [5,4,3,2,1]
        if is_str and is_flush: return (9 if values[0]==14 else 8, values)
        if freq==[4,1]:         return (7, values)
        if freq==[3,2]:         return (6, values)
        if is_flush:            return (5, values)
        if is_str:              return (4, values)
        if freq==[3,1,1]:       return (3, values)
        if freq==[2,2,1]:       return (2, values)
        if freq==[2,1,1,1]:     return (1, values)
        return (0, values)

    if len(cards) < 5:
        return None
    best = None
    for combo in combinations(cards, 5):
        s = score_five(combo)
        if best is None or (s[0],s[1]) > (best[0],best[1]):
            best = s
    return best

def build_deck(exclude):
    deck = [r+s for r in CARD_VALUES for s in ['h','d','c','s']]
    excl = set(e.lower() for e in exclude)
    return [c for c in deck if c not in excl]

def monte_carlo_equity(hand, board, simulations=1500):
    if len(hand) < 2:
        return None
    deck         = build_deck(hand + board)
    cards_needed = 5 - len(board)
    wins = ties = total = 0
    for _ in range(simulations):
        if len(deck) < cards_needed + 2:
            break
        sample    = random.sample(deck, cards_needed + 2)
        sim_board = board + sample[:cards_needed]
        opp       = sample[cards_needed:]
        my_r      = evaluate_hand(hand + sim_board)
        op_r      = evaluate_hand(opp  + sim_board)
        if my_r is None or op_r is None:
            continue
        if   (my_r[0],my_r[1]) > (op_r[0],op_r[1]): wins += 1
        elif my_r == op_r: ties += 1
        total += 1
    return (wins + ties * 0.5) / total if total > 0 else None

def kelly_fraction(p, cap=0.25):
    if not p: return 0.0
    return max(0.0, min(p - (1-p), cap))

def make_decision(win_prob, stack, pot, call_amount, big_blind):
    if win_prob is None:
        return ("check_call", 0) if call_amount == 0 else ("check_call", call_amount)
    pot_odds   = pot / call_amount if call_amount > 0 else float('inf')
    req_equity = call_amount / (pot + call_amount) if call_amount > 0 else 0
    kelly_size = round(stack * kelly_fraction(win_prob), 2)
    min_raise  = max(int(big_blind*2), int(call_amount*2))

    if call_amount > 0 and win_prob < req_equity and win_prob < 0.35:
        return ("fold", 0)
    if call_amount == 0 and win_prob < 0.45:
        return ("check_call", 0)
    if 0.35 <= win_prob < 0.55 and call_amount > 0:
        return ("check_call", int(min(call_amount,stack))) if pot_odds >= 1/win_prob else ("fold",0)
    if call_amount == 0 and 0.45 <= win_prob < 0.70:
        return ("raise", int(min(max(round(pot*0.6), big_blind*2), stack)))
    if win_prob >= 0.70:
        return ("raise", int(min(max(kelly_size, min_raise), stack)))
    if win_prob >= 0.55 and call_amount > 0:
        return ("raise", int(min(max(min_raise, round(pot*0.75)), stack)))
    return ("check_call", 0) if call_amount == 0 else ("check_call", int(min(call_amount,stack)))


# CAMERA / YOLO

model = YOLO(MODEL_PATH)

def capture_frames(camera_index, duration=SCAN_DURATION):
    cap    = cv2.VideoCapture(camera_index)
    frames = []
    start  = time.time()
    while time.time() - start < duration:
        ret, frame = cap.read()
        if ret:
            frames.append(frame)
    cap.release()
    return frames

def detect_cards(frames):
    seen, detected = set(), []
    for frame in frames:
        for result in model(frame, conf=0.8, verbose=False):
            for box in result.boxes:
                label = model.names[int(box.cls[0])]
                conf  = float(box.conf[0])
                card  = yolo_to_server(label)
                if card and card not in seen:
                    seen.add(card)
                    detected.append((card, conf))
    return detected

def scan_cameras():
    print("  [CAM] Scanning hand...")
    hand_frames  = capture_frames(CAM_HAND_INDEX)
    print("  [CAM] Scanning board...")
    board_frames = capture_frames(CAM_BOARD_INDEX)

    hand_cards  = detect_cards(hand_frames)
    board_cards = detect_cards(board_frames)
    board_set   = {c for c,_ in board_cards}
    hand_cards  = [(c,conf) for c,conf in hand_cards if c not in board_set]

    if hand_frames:
        cv2.imshow("Hand (Cam 4)",  model(hand_frames[-1],  conf=0.8, verbose=False)[0].plot())
    if board_frames:
        cv2.imshow("Board (Cam 2)", model(board_frames[-1], conf=0.8, verbose=False)[0].plot())
    cv2.waitKey(1)

    print(f"  [CAM] Hand:  {[c for c,_ in hand_cards]}")
    print(f"  [CAM] Board: {[c for c,_ in board_cards]}")
    return hand_cards, board_cards

# HTTP CLIENT

class PokerClient:
    def __init__(self, base_url):
        self.base    = base_url.rstrip("/")
        self.session = requests.Session()

    def register(self, u, p):
        return self.session.post(f"{self.base}/api/auth/register", json={"username":u,"password":p}).json()

    def login(self, u, p):
        return self.session.post(f"{self.base}/api/auth/login", json={"username":u,"password":p}).json()

    def get_state(self):
        return self.session.get(f"{self.base}/api/state").json().get("state")

    def robot_action(self, action_type, amount=None):
        payload = {"type": action_type}
        if amount is not None:
            payload["amount"] = int(amount)
        return self.session.post(f"{self.base}/api/robot/action", json=payload).json()

    def vision_robot(self, detections):
        return self.session.post(f"{self.base}/api/vision/robot",
            json={"detections": [{"card":c,"confidence":conf} for c,conf in detections]}).json()

    def vision_board(self, detections):
        return self.session.post(f"{self.base}/api/vision/board",
            json={"detections": [{"card":c,"confidence":conf,
                                  "slot": slot if slot is not None else -1}
                                 for c,conf,slot in detections]}).json()

    def vision_reset(self):
        self.session.post(f"{self.base}/api/vision/reset")

# CARD PUSH

def push_cards(client, hand_det, board_det, current_board):
    if hand_det:
        result  = client.vision_robot(hand_det)
        applied = result.get("applied", [])
        if not applied:
            time.sleep(0.3)
            hand2, _ = scan_cameras()
            if hand2:
                result  = client.vision_robot(hand2)
                applied = result.get("applied", [])
        print(f"  [CARDS] Robot hole: {applied if applied else '(pending)'}")

    if board_det:
        empty   = [i for i,c in enumerate(current_board) if not c]
        slotted = [(c, conf, empty[i] if i < len(empty) else None)
                   for i,(c,conf) in enumerate(board_det)]
        result  = client.vision_board(slotted)
        applied = result.get("applied", [])
        print(f"  [CARDS] Board: {[(a['slot']+1,a['card']) for a in applied] if applied else '(pending)'}")

# ROBOT DECISION

def robot_act(client, table):
    robot_player = table["players"][0]
    stack     = robot_player["stack"]
    pot       = table["pot"]
    call_amt  = max(0, table["currentBet"] - robot_player["currentBet"])
    big_blind = max(table["currentBet"], 2)
    hole      = [c for c in robot_player["hole"] if c]
    board     = [c for c in table["board"] if c]

    win_prob        = monte_carlo_equity(hole, board)
    action, amount  = make_decision(win_prob, stack, pot, call_amt, big_blind)
    prob_str        = f"{win_prob*100:.1f}%" if win_prob is not None else "N/A"
    label           = action.upper() + (f" ${amount}" if amount > 0 else "")
    print(f"\n  [ROBOT] Win={prob_str}  hole={hole}  board={board}  →  {label}")

    if action == "fold":
        client.robot_action("fold")
        arm_fold()
        speak("fold")

    elif action == "raise" and amount > 0:
        client.robot_action("raise", amount)
        arm_raise(amount)
        speak("raise")

    elif call_amt > 0:
        client.robot_action("check_call")
        arm_call(call_amt)
        speak("call")

    else:
        client.robot_action("check_call")
        arm_check()
        speak("check")

    return label

# DISPLAY

def print_status(state, last_action):
    table  = state["table"]
    phases = state["phases"]
    phase  = phases[table["phaseIndex"]]
    robot_player = table["players"][0]
    to_act = table["currentTurn"]
    to_act_name = table["players"][to_act]["name"] if to_act is not None else "none"
    hole   = [c for c in robot_player["hole"] if c]
    board  = [c for c in table["board"] if c]

    print("\033[2J\033[H", end="")  # clear terminal
    print("=" * 54)
    print("  POKER ROBOT  |  operator terminal")
    print("=" * 54)
    print(f"  Phase        : {phase}")
    print(f"  Pot          : ${table['pot']}    Current bet: ${table['currentBet']}")
    print(f"  To act       : {to_act_name}")
    print(f"  Robot hole   : {hole if hole else '??'}")
    print(f"  Board        : {board if board else '—'}")
    print(f"  Robot stack  : ${robot_player['stack']}")
    print(f"  Round closed : {table['roundClosed']}")
    print(f"  Arm          : {'enabled (' + ARM_PORT + ')' if ARM_ENABLED else 'disabled'}")
    print("-" * 54)
    print("  Players:")
    for p in table["players"]:
        if not p["occupied"]:
            continue
        turn   = " ◀" if p["seatIndex"] == to_act else ""
        fold   = " FOLDED" if p["folded"] else ""
        print(f"    [{p['seatIndex']}] {p['name']:<12} ${p['stack']:>6}  bet:${p['currentBet']}{fold}{turn}")
    print("-" * 54)
    if table["actionLog"]:
        print(f"  Last log : {table['actionLog'][0]}")
    if last_action:
        print(f"  Robot did: {last_action}")
    print("-" * 54)
    print("  S=Scan   SPACE=Next street   N=New hand   Q=Quit")
    print("=" * 54)

# MAIN

def authenticate(client, username, password):
    r = client.login(username, password)
    if r.get("ok"):
        print(f"[AUTH] Logged in as '{username}'.")
        return True
    r = client.register(username, password)
    if r.get("ok"):
        print(f"[AUTH] Registered '{username}'.")
        return True
    print(f"[AUTH] Failed: {r.get('message')}")
    return False

def main():
    global ARM_PORT, ARM_ID, ARM_ENABLED

    parser = argparse.ArgumentParser()
    parser.add_argument("--host",       default=DEFAULT_HOST)
    parser.add_argument("--username",   default=ROBOT_USERNAME)
    parser.add_argument("--password",   default=ROBOT_PASSWORD)
    parser.add_argument("--arm-port",   default=ARM_PORT,
                        help="USB port for SO101 follower arm (default: /dev/ttyACM1)")
    parser.add_argument("--arm-id",     default=ARM_ID,
                        help="LeRobot robot ID (default: follower)")
    parser.add_argument("--no-arm",     action="store_true",
                        help="Disable arm movements (software-only mode)")
    args = parser.parse_args()

    ARM_PORT    = args.arm_port
    ARM_ID      = args.arm_id
    ARM_ENABLED = not args.no_arm

    print("=" * 54)
    print("  POKER ROBOT CONTROLLER")
    print(f"  Server : {args.host}")
    print(f"  Arm    : {'disabled (--no-arm)' if not ARM_ENABLED else ARM_PORT + '  id=' + ARM_ID}")
    print("=" * 54)

    for attempt in range(10):
        try:
            if requests.get(f"{args.host}/api/health", timeout=3).ok:
                break
        except Exception:
            pass
        print(f"[NET] Waiting for server... ({attempt+1}/10)")
        time.sleep(2)
    else:
        print("[NET] Could not reach server.")
        sys.exit(1)

    client = PokerClient(args.host)
    if not authenticate(client, args.username, args.password):
        sys.exit(1)

    # Connect the physical arm (non-fatal if unavailable)
    arm_connect(ARM_PORT, ARM_ID)

    last_action = None
    last_turn   = None
    last_phase  = None

    print("\nReady. Press S to scan, SPACE=next street, N=new hand, Q=quit.\n")
    time.sleep(1)
    enable_raw()
    try:
        while True:
            # ── fetch state ──
            try:
                state = client.get_state()
            except Exception as e:
                restore_term()
                print(f"[NET] {e}")
                enable_raw()
                time.sleep(1)
                continue

            if state is None:
                time.sleep(POLL_INTERVAL)
                continue

            table  = state["table"]
            phases = state["phases"]
            phase  = phases[table["phaseIndex"]]

            if phase == "Preflop" and last_phase not in (None, "Preflop"):
                print("\n[GAME] New hand — resetting vision.")
                client.vision_reset()
                last_action = None
                last_turn   = None

            last_phase = phase

            current_turn = table["currentTurn"]
            if current_turn == 0 and current_turn != last_turn:
                last_turn = current_turn
                time.sleep(DECISION_DELAY)
                fresh = client.get_state()
                if fresh:
                    last_action = robot_act(client, fresh["table"])


            if current_turn != 0:
                last_turn = None

            print_status(state, last_action)

            key = get_key_nonblocking()
            if key is None:
                time.sleep(POLL_INTERVAL)
                continue

            key = key.lower()

            if key in ('q', '\x03'):
                restore_term()
                print("\n[EXIT] Quitting.")
                break

            elif key == 's':
                print("\n[SCAN] Scanning cameras...")
                hand_det, board_det = scan_cameras()
                push_cards(client, hand_det, board_det, table["board"])

            elif key == ' ':
                if not table["roundClosed"]:
                    print("\n[STREET] Round not closed — all players must act first.")
                else:
                    result = client.robot_action("advance_street")
                    if result.get("ok"):
                        print("\n[STREET] Advanced.")
                        speak("advance_street")
                        time.sleep(0.5)
                        fresh = client.get_state()
                        if fresh:
                            _, board_det = scan_cameras()
                            if board_det:
                                push_cards(client, [], board_det, fresh["table"]["board"])
                    else:
                        print(f"\n[STREET] {result.get('message','failed')}")

            elif key == 'n':
                result = client.robot_action("new_hand")
                if result.get("ok"):
                    print("\n[HAND] New hand started.")
                    #arm_wave()
                    speak("hate")
                    client.vision_reset()
                    last_action = None
                    last_turn   = None
                    time.sleep(0.5)
                    hand_det, _ = scan_cameras()
                    fresh = client.get_state()
                    if fresh and hand_det:
                        push_cards(client, hand_det, [], fresh["table"]["board"])
                else:
                    print(f"\n[HAND] {result.get('message','failed')}")

    except Exception:
        pass
    finally:
        restore_term()
        arm_disconnect()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
