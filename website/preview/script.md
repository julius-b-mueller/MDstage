```yaml
config:
    app_version: 1.0.0
    roles:
        Frank:
            color: blue
            ch: null
        Thomas:
            color: red
            ch: null
        Christian:
            color: green
            ch: null
        Annabel:
            color: yellow
            ch: null
        Julie:
            color: purple
            ch: null
        Mathilda:
            color: cyan
            ch: null
```

# Online-Demo

```yaml
mic:
    - Frank
    - Thomas
    - Christian
    - Annabel
    - Julie
    - Mathilda
trigger_note:
    ch: 1
    note: 1
```

**Mathilda**
Hello everyone!
I am Mathilda and today, I want you to introduce to MainDesk.
To add role text, SHIFT+CLICK a line just type the first few letters of a role name and press TAB when the correct role name is shown.

**Thomas**
That's cool.
How can I adjust, which roles exist?

**Mathilda**
Well, It's not possible in the web-preview, but in the main software, there is a menu where you can edit your roles.
Maybe everyone can just introduce themselves so the user knows, who is here.
Thomas, would you like to start?

**Thomas**
Hello, I'm Thomas.

**Annabel**
Hello, my name is Annabel.

**Frank**
Howdy, Frank here!

**Christian**
I'm Christian.

**Mathilda**
So that's who we are.
There's a question.
Annabel, go on.

**Annabel**
How can I write stage directions?

**Mathilda**
That's quite easy.
Just add a line and type your stage direction without typing the role name and TAB in the beginning

*Annabel writes some stage directions.*

**Mathilda**
Yeah, you did it *(proudly thinking about how cool MainDesk actually is)* Easy, huh?

**Julie**
Oh, do you see that?
There's white stage directions inside your speech.
How did you do that?

**Mathilda**
Well, apart from the fact that I please you to not read my thoughts...
Just type your stage directions inside parentheses and it will automatically be treated as stage directions.
Let us now dive into all the cue logic.
Drumroll, please!

```yaml
music:
    file: drumroll.mp3
    volume: 0.8
    start: 2.326
    end: 7.605
    fadein: 0.097
    fadeout: 0.79
trigger_note:
    ch: 1
    note: 2
```

**Frank**
This file has lots of silence in the beginning and in the end.
You trimmed it, right?

**Mathilda**
Exactly.
By while holding SHIFT, you can adjust in, out, fadein and fadeout.

**Frank**
So I don't even have to open a cutting software?

**Mathilda**
Correct!

## Loops

**Christian**
What if I need music that keeps playing throughout a whole scene?
Like background music that doesn't stop on its own?

**Mathilda**
That's what loops are for.
Just add `loop: true` to the music block.
The music repeats endlessly until you press Go again.

```yaml
music:
    file: background.mp3
    loop: true
trigger_note:
    ch: 1
    note: 3
```

**Thomas**
But won't it cut off abruptly when Go is pressed?

**Mathilda**
Exactly what I was about to explain.
You create a separate outro cue and link it to the loop using `loop_outro`.
When you press Go, MainDesk waits until the current loop iteration finishes — then starts the outro seamlessly.
No jarring cuts, no timing stress.

```yaml
music:
    file: background_outro.mp3
loop_outro:
    ch: 1
    note: 3
trigger_note:
    ch: 1
    note: 4
```

**Frank**
So it waits for the perfect musical moment to end?

**Mathilda**
Exactly.
You just press Go when the scene ends and the software handles the rest.

## Variants

**Annabel**
We sometimes do the same show with different casts and sing songs in different keys.
Do I need a completely separate show file for that?

**Mathilda**
Not at all.
You can create variant cues — multiple versions of the same cue that appear side by side in the live view.
Before pressing Go, you just click the right variant.
Both blink until you choose — then Go becomes active.

*The next two cues are a variant group — see how they appear side by side.*

```yaml
music:
    file: song_e_major.mp3
note: E major (high)
trigger_note:
    ch: 1
    note: 5
```

```yaml
music:
    file: song_c_major.mp3
note: C major (low)
sibling: true
trigger_note:
    ch: 1
    note: 6
```

**Annabel**
Oh — so I can't accidentally play the wrong key!

**Mathilda**
Exactly.
And you can have as many variants as you need.

## Auto-Cues

**Julie**
Can a cue trigger itself automatically at a specific point in the music?

**Mathilda**
Yes — that's the auto-trigger feature.
You set a time position inside a playing cue, and when playback reaches that point, the linked cue fires by itself.

**Julie**
How do you set the time position?

**Mathilda**
Let the audio play to the right moment, then click the Auto-Cue button on the target cue.
No typing timecodes.
The next cue fires automatically 8 seconds into the song variant above.

```yaml
note: fires automatically at 8 s in the song cue
auto_trigger:
    trigger_note:
        ch: 1
        note: 5
    at: 8.0
trigger_note:
    ch: 1
    note: 7
```

**Frank**
So things that have to happen in exact sync with the music just... happen?

**Mathilda**
Exactly.
No human reaction time, no stress.

## Cues Affecting Other Cues

**Thomas**
What if I want the background loop to fade out when the dialogue scene starts?
Do I need an extra Go press just for the fade?

**Mathilda**
No — a cue can affect another cue when it fires.
This one fades out our loop from before over three seconds, automatically.

```yaml
music:
    adjust:
        trigger_note:
            ch: 1
            note: 3
        fadeout: true
        fadetime: 3
trigger_note:
    ch: 1
    note: 8
```

**Thomas**
So I fire one cue and the background disappears by itself?

**Mathilda**
Exactly.
You can also set it to a specific volume instead of fading all the way out.
Less to think about during the show.

## Lighting & OSC

**Christian**
Can MainDesk also talk to a lighting console?

**Mathilda**
Yes — you can send MIDI notes to any system that listens, or send OSC messages over the network.
You can also just write the scene name as a reminder in the cue.

```yaml
light: Scene 5 – Warm Amber
trigger_note:
    ch: 1
    note: 9
```

**Christian**
And if my lighting console is set up to receive MIDI, it fires automatically with the cue?

**Mathilda**
Exactly.
MainDesk is the hub — sound, microphones, light, MIDI timecode for video.
Everything from one Go button.

## Go and Back

**Frank**
*(nervously eyeing the Go button)*
What happens if I press Go one cue too early?

**Mathilda**
That's what Back is for.
Press Back and MainDesk fully restores the previous state.
If a loop was playing, it restarts.
If a mic was open, it reopens.
If a light scene changed, the previous one is re-triggered.

**Frank**
So one accidental Go is not a disaster?

**Mathilda**
Not at all.
One Back press and everything is exactly as it was.

**Thomas**
What if I hold Back for a longer time?

**Mathilda**
Long-pressing Back is the emergency stop — all audio fades out immediately.
Useful when something goes very wrong on stage.

## Moving and Editing Cues

**Annabel**
I notice there are small arrow buttons on each cue.
What are those for?

**Mathilda**
Those are the move buttons.
You can reorder cues directly inside the script — no text editor needed.
Just click the arrows to shift a cue up or down.

**Julie**
And if I want to change a cue's settings?

**Mathilda**
Click Edit on any cue.
You can change the audio file, set start and end points, configure fades, assign mic channels, set a light scene — everything through the interface.

**Annabel**
*(slightly overwhelmed)*
This is quite a lot of features.

**Mathilda**
It is — but you start simple.
Just a script and a Go button.
You add audio, then mic routing, then lighting, as your production grows.
Most shows only use a fraction of this.

## That's a Wrap!

**Frank**
Great demo, Mathilda.
I'm going to try this for our next production.

**Thomas**
Same here.

**Mathilda**
Wonderful!
To use the full app — with real audio output, MIDI, a second screen for the live view, and everything else — download MainDesk for free.
No account, no subscription, no telemetry.

*Everyone waves goodbye.*

```yaml
music:
    file: outro_fanfare.mp3
    volume: 0.9
    fadeout: 1.5
trigger_note:
    ch: 1
    note: 10
```
