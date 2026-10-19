"""The Trial of the Rising Sun: the clearance questionnaire.

Questions are about Japan, the "Land of the Rising Sun": its myths, symbols, history, warriors, folklore and
arts.  The bank lives here, on the server, so the answers never reach the browser; a trial draws a random
selection from every scroll (section), shuffles the choices, and is graded here too.

A question is  (kind, weight, text, options, answer)
  kind "one"   pick one option;                     answer = index of the right option
  kind "multi" pick every option that applies;       answer = set of indexes (all or nothing)
  kind "text"  type the answer;                      answer = tuple of accepted spellings (see norm())
weight 1 = easy, 2 = medium, 3 = hard.
"""
from __future__ import annotations

import re
import unicodedata

PER_SECTION = 6                      # questions drawn from each scroll
LEVELS = [                           # (minimum percent, level, rank, what it means)
    (93, 4, "SHOGUN", "supreme commander of the realm"),
    (80, 3, "DAIMYO", "lord of a domain"),
    (65, 2, "SAMURAI", "sworn blade of a lord"),
    (50, 1, "ASHIGARU", "foot soldier of the ranks"),
    (0, 0, "RONIN", "masterless: access denied"),
]


def level_for(pct):
    for lo, lvl, name, _ in LEVELS:
        if pct >= lo:
            return lvl, name
    return 0, "RONIN"


def rank_name(level):
    return next((n for _, l, n, _ in LEVELS if l == level), "RONIN")


SECTIONS = [
    {"id": "kami", "title": "THE AGE OF THE KAMI", "sub": "Myths of creation, the sun goddess and the first emperor"},
    {"id": "land", "title": "THE LAND OF THE RISING SUN", "sub": "Names, symbols and sacred places"},
    {"id": "eras", "title": "ERAS OF THE SHOGUNS", "sub": "Courts, clans and the turning of the ages"},
    {"id": "bushi", "title": "THE WAY OF THE WARRIOR", "sub": "Samurai, swords and the code of bushido"},
    {"id": "yokai", "title": "SPIRITS, FOXES AND FOLK TALES", "sub": "Kami, yokai and the stories told by firelight"},
    {"id": "arts", "title": "ARTS, RITES AND LANGUAGE", "sub": "Poetry, tea, shrines and the written word"},
]

BANK = {
    "kami": [
        ("text", 1, "Type the name of the sun goddess, from whom the imperial line claims descent.", None,
         ("amaterasu", "amaterasuomikami", "amaterasuoomikami")),
        ("one", 1, "Which two kami stirred the sea with a jeweled spear and gave birth to the islands of Japan?",
         ["Izanagi and Izanami", "Susanoo and Kushinada", "Ninigi and Konohanasakuya", "Hachiman and Inari"], 0),
        ("one", 1, "After her brother's rampage, Amaterasu hid and the world went dark. Where did she hide?",
         ["In the Heavenly Rock Cave (Ama-no-Iwato)", "Inside Mount Fuji", "In the Dragon Palace under the sea",
          "Under the roots of the world tree"], 0),
        ("one", 2, "Which goddess danced so wildly that the assembled gods laughed and drew Amaterasu out of her cave?",
         ["Ame-no-Uzume", "Benzaiten", "Izanami", "Konohanasakuya-hime"], 0),
        ("one", 1, "Amaterasu has two noble siblings, born as Izanagi purified himself. One is Susanoo, the storm god. "
                   "Who is the other?",
         ["Tsukuyomi, god of the moon", "Hachiman, god of war", "Raijin, god of thunder", "Ebisu, god of luck"], 0),
        ("one", 2, "The sword Kusanagi was said to have been found inside the tail of which monster?",
         ["Yamata no Orochi, the eight-headed serpent", "The Nue", "A giant catfish, Namazu", "The Nine-Tailed Fox"], 0),
        ("multi", 3, "Select all three Imperial Regalia of Japan (Sanshu no Jingi).",
         ["The mirror, Yata no Kagami", "The sword, Kusanagi", "The jewel, Yasakani no Magatama",
          "The jeweled spear, Ame-no-Nuboko", "The bow, Hamayumi"], {0, 1, 2}),
        ("one", 1, "Who is traditionally counted as Japan's first emperor, said to have founded the state in 660 BCE?",
         ["Jimmu", "Shotoku", "Kanmu", "Meiji"], 0),
        ("one", 3, "Ninigi, Amaterasu's grandson, descended from heaven to rule the land. Which sacred objects "
                   "did she give him to take along?",
         ["The three Regalia: mirror, sword and jewel", "Two swords and a bow", "A spear and a drum",
          "A lantern and a sacred rope"], 0),
    ],
    "land": [
        ("one", 1, "What does the name Nihon / Nippon (日本) literally mean?",
         ["Origin of the sun", "Land of many islands", "Realm of the gods", "Eastern harbour"], 0),
        ("one", 2, "A famous 607 letter to the Sui court of China spoke of a ruler 'where the sun rises' addressing "
                   "one 'where the sun sets'. It is attributed to the court of which regent?",
         ["Prince Shotoku", "Oda Nobunaga", "Minamoto no Yoritomo", "Fujiwara no Michinaga"], 0),
        ("one", 3, "In which year was the Hinomaru, the red disc on white, formally made the national flag by law?",
         ["1999", "1868", "1945", "1964"], 0),
        ("one", 2, "Whose ensign carries the red disc with sixteen rays, the 'Rising Sun Flag', today?",
         ["The Maritime Self-Defense Force (navy)", "The Air Self-Defense Force", "The Japan Coast Guard",
          "The national police"], 0),
        ("one", 1, "Which flower, with sixteen petals, is the crest of the Imperial family?",
         ["Chrysanthemum", "Cherry blossom", "Lotus", "Plum"], 0),
        ("one", 3, "Mount Fuji's shrines are dedicated to which blossoming goddess?",
         ["Konohanasakuya-hime", "Amaterasu", "Benzaiten", "Kannon"], 0),
        ("one", 2, "The Inner Shrine of Ise, dedicated to Amaterasu, is ritually rebuilt on a fresh site every...",
         ["20 years", "5 years", "100 years", "Never; it is the oldest wooden building in the world"], 0),
        ("one", 1, "What is the name of the traditional gateway that marks the entrance to a Shinto shrine?",
         ["Torii", "Shoji", "Engawa", "Noren"], 0),
        ("one", 2, "Through which port did Edo-period Japan keep its one window to Europe, trading with the Dutch?",
         ["Dejima, in Nagasaki", "Yokohama", "Hakodate", "Osaka"], 0),
    ],
    "eras": [
        ("one", 2, "The capital was moved to Heian-kyo (modern Kyoto) in which year?",
         ["794", "710", "1185", "1603"], 0),
        ("one", 1, "Which two great clans fought the Genpei War (1180-1185)?",
         ["Minamoto and Taira", "Tokugawa and Toyotomi", "Oda and Takeda", "Fujiwara and Soga"], 0),
        ("one", 1, "Who became the first shogun of the Kamakura shogunate in 1192?",
         ["Minamoto no Yoritomo", "Ashikaga Takauji", "Tokugawa Ieyasu", "Taira no Kiyomori"], 0),
        ("one", 1, "Typhoons wrecked the Mongol invasion fleets of 1274 and 1281. What did the Japanese call this "
                   "'divine wind'?",
         ["Kamikaze", "Tsunami", "Shinkansen", "Kaiten"], 0),
        ("text", 2, "Type the name (in Japanese) of the 'Warring States' era, the century of civil war before "
                    "unification.", None, ("sengoku", "sengokujidai")),
        ("one", 2, "Which warlord was betrayed by his general Akechi Mitsuhide at Honno-ji temple in 1582?",
         ["Oda Nobunaga", "Toyotomi Hideyoshi", "Takeda Shingen", "Uesugi Kenshin"], 0),
        ("one", 1, "Which battle of 1600 decided the struggle for power in favour of Tokugawa Ieyasu?",
         ["Sekigahara", "Okehazama", "Dan-no-ura", "Nagashino"], 0),
        ("one", 2, "What was the Edo-period policy of near-total national isolation called?",
         ["Sakoku", "Haihan-chiken", "Bakumatsu", "Kokutai"], 0),
        ("one", 2, "Whose 1853 arrival with the 'Black Ships' pried Japan open and helped end the shogunate?",
         ["Commodore Matthew Perry", "Captain James Cook", "Francis Xavier", "William Adams"], 0),
        ("one", 1, "In 1868 the shogunate fell and imperial rule was restored. What is this event called?",
         ["The Meiji Restoration", "The Taika Reform", "The Kemmu Restoration", "The Showa Reform"], 0),
    ],
    "bushi": [
        ("one", 1, "What is a samurai without a lord or master called?",
         ["Ronin", "Ninja", "Ashigaru", "Daimyo"], 0),
        ("one", 2, "In the code of bushido, which virtue is 'yu'?",
         ["Courage", "Respect", "Benevolence", "Rectitude"], 0),
        ("one", 2, "A samurai's matched pair of long and short swords is known as the...",
         ["Daisho", "Tanto", "Naginata", "Tachi"], 0),
        ("one", 3, "In 1702 forty-seven ronin avenged their lord Asano by killing which court official?",
         ["Kira Yoshinaka", "Yanagisawa Yoshiyasu", "Ii Naosuke", "Sakai Tadakiyo"], 0),
        ("one", 1, "Which swordsman wrote 'The Book of Five Rings'?",
         ["Miyamoto Musashi", "Sasaki Kojiro", "Yagyu Munenori", "Tsukahara Bokuden"], 0),
        ("one", 3, "Musashi's school, 'Two Heavens as One', is known for fighting with...",
         ["Two swords at once", "A spear and shield", "A bow from horseback", "A chain and sickle"], 0),
        ("one", 2, "Which castle, a UNESCO site, is nicknamed the 'White Heron'?",
         ["Himeji Castle", "Osaka Castle", "Matsumoto Castle", "Edo Castle"], 0),
        ("one", 2, "Which celebrated woman warrior (onna-bugeisha) rode with Minamoto no Yoshinaka in the Genpei War?",
         ["Tomoe Gozen", "Hojo Masako", "Murasaki Shikibu", "Nene"], 0),
        ("text", 1, "Type the Japanese word for the ritual suicide by which a disgraced samurai kept his honour.",
         None, ("seppuku", "harakiri")),
    ],
    "yokai": [
        ("one", 1, "Which animal is the messenger of Inari, kami of rice and prosperity?",
         ["The fox (kitsune)", "The crane", "The tanuki", "The carp"], 0),
        ("one", 1, "Which long-nosed, winged mountain spirit is also a legendary master of swordsmanship?",
         ["Tengu", "Kappa", "Oni", "Tanuki"], 0),
        ("one", 1, "Kappa, the water imps with a dish of water on their heads, are said to adore which food?",
         ["Cucumbers", "Rice balls", "Persimmons", "Sake"], 0),
        ("one", 3, "In folklore, an everyday object that comes alive after a hundred years is called a...",
         ["Tsukumogami", "Jorogumo", "Yurei", "Nurikabe"], 0),
        ("one", 2, "Urashima Taro visits the Dragon Palace beneath the sea. What happens when he opens the "
                   "box (tamatebako) given to him on leaving?",
         ["He instantly ages into an old man", "He becomes a turtle", "A storm sinks his boat", "He is given immortality"], 0),
        ("multi", 2, "Select the three companions who join Momotaro, the Peach Boy, on his quest.",
         ["A dog", "A monkey", "A pheasant", "A cat", "A rabbit"], {0, 1, 2}),
        ("one", 2, "At Tanabata, the star lovers Orihime and Hikoboshi may meet once a year, across which river?",
         ["The Milky Way (Amanogawa)", "The Sanzu River", "The Kamo River", "The Sumida River"], 0),
        ("one", 2, "Which of the Seven Lucky Gods (Shichifukujin) is the only goddess?",
         ["Benzaiten", "Ebisu", "Daikokuten", "Hotei"], 0),
        ("one", 1, "At Setsubun, people throw roasted soybeans out of the house to drive away which creatures?",
         ["Oni (ogres)", "Tengu", "Kappa", "Kitsune"], 0),
        ("text", 2, "Type the name of the Japanese raccoon-dog, a shapeshifting trickster often shown with a huge belly "
                    "and a sake bottle.", None, ("tanuki",)),
    ],
    "arts": [
        ("one", 2, "Which tea master perfected the 'wabi-cha' ceremony under Toyotomi Hideyoshi?",
         ["Sen no Rikyu", "Zeami", "Hokusai", "Basho"], 0),
        ("one", 2, "Which poet wrote 'The Narrow Road to the Deep North' (Oku no Hosomichi)?",
         ["Matsuo Basho", "Kobayashi Issa", "Yosa Buson", "Masaoka Shiki"], 0),
        ("one", 1, "Who wrote 'The Tale of Genji' in the Heian court, around the year 1000?",
         ["Murasaki Shikibu", "Sei Shonagon", "Ono no Komachi", "Izumi Shikibu"], 0),
        ("one", 1, "Which of Japan's scripts is mostly used for foreign loanwords?",
         ["Katakana", "Hiragana", "Kanji", "Romaji"], 0),
        ("one", 2, "Kintsugi is the art of repairing broken pottery with...",
         ["Lacquer dusted with gold", "Bamboo splints", "Red clay", "Silk thread"], 0),
        ("one", 3, "The aesthetic of gentle sadness at the passing of things, so tied to falling cherry blossom, is...",
         ["Mono no aware", "Wabi-sabi", "Iki", "Yugen"], 0),
        ("one", 2, "In which century did Buddhism formally reach Japan, via the Korean kingdom of Baekje?",
         ["The 6th", "The 2nd", "The 9th", "The 12th"], 0),
        ("one", 1, "How many syllables make up a haiku, in its traditional 5-7-5 pattern?",
         ["17", "21", "31", "12"], 0),
        ("text", 3, "Type the Japanese word for the custom of gathering under cherry trees to enjoy the blossom.",
         None, ("hanami",)),
    ],
}


def norm(text):
    """Lowercase, drop accents (o with macron -> o) and everything that isn't a letter or digit."""
    t = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", t.lower())


def build(rng):
    """A new trial: PER_SECTION random questions from every scroll, choices shuffled.
    Returns (public, key): `public` goes to the browser, `key` stays on the server for grading."""
    public, key, n = [], [], 0
    for sec in SECTIONS:
        pool = BANK[sec["id"]]
        for qi in rng.sample(range(len(pool)), min(PER_SECTION, len(pool))):
            kind, weight, text, options, answer = pool[qi]
            item = {"n": n, "s": sec["id"], "t": kind, "q": text}
            perm = None
            if options is not None:
                perm = list(range(len(options)))
                rng.shuffle(perm)
                item["o"] = [options[p] for p in perm]
            public.append(item)
            key.append({"s": sec["id"], "kind": kind, "w": weight, "perm": perm, "answer": answer,
                        "nopts": len(options) if options else 0})
            n += 1
    return public, key


def right(k, given):
    """Is one submitted answer correct?  `given` is whatever the browser sent; anything odd is just wrong."""
    try:
        if k["kind"] == "one":
            if isinstance(given, bool) or not isinstance(given, int) or not 0 <= given < k["nopts"]:
                return False
            return k["perm"][given] == k["answer"]
        if k["kind"] == "multi":
            if not isinstance(given, list) or len(given) > k["nopts"]:
                return False
            picked = set()
            for g in given:
                if isinstance(g, bool) or not isinstance(g, int) or not 0 <= g < k["nopts"]:
                    return False
                picked.add(k["perm"][g])
            return picked == set(k["answer"])
        if k["kind"] == "text":
            return isinstance(given, str) and len(given) <= 80 and norm(given) in k["answer"]
    except (TypeError, IndexError):
        pass
    return False


def grade(key, answers):
    """-> {pct, level, rank, correct, total, sections: [{id, title, pct}]}"""
    answers = answers if isinstance(answers, list) else []
    per = {s["id"]: [0, 0] for s in SECTIONS}
    got = tot = ok = 0
    for i, k in enumerate(key):
        hit = right(k, answers[i] if i < len(answers) else None)
        per[k["s"]][1] += k["w"]
        tot += k["w"]
        if hit:
            per[k["s"]][0] += k["w"]
            got += k["w"]
            ok += 1
    pct = round(100 * got / tot) if tot else 0
    level, rank = level_for(pct)
    return {"pct": pct, "level": level, "rank": rank, "correct": ok, "total": len(key),
            "sections": [{"id": s["id"], "title": s["title"], "pct": round(100 * per[s["id"]][0] / per[s["id"]][1]) if per[s["id"]][1] else 0}
                         for s in SECTIONS]}
