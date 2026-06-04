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
    settings:
        MacBook-Pro-von-Julius:
            mainAudioDevice: null
            mainChannelL: 0
            mainChannelR: 1
            monitorChannelL: null
            monitorChannelR: null
            monitorEnabled: false
            midiX32Device: null
            midiTriggerDevice: null
            midiTCDevice: null
            midiGoNote: null
            midiBackNote: null
            midiLiveDevice: null
            appLanguage: de
            oscEnabled: false
            oscHost: 127.0.0.1
            oscPort: 8000
            micMuteMethod: x32
            micMuteMidiUnmute: B1 {ch} 00
            micMuteMidiMute: B1 {ch} 7F
            micMuteOscPath: /ch/{ch}/mix/on
            micMuteOscUnmute: '1'
            micMuteOscMute: '0'
```

# Online-Demo

# Dialog and Stage Directions

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
To add role text, SHIFT+CLICK between two lines and just type the first few letters of a role name and press TAB when the correct role name is shown.
To edit a text, you can just SHIFT+CLICK a line.

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

**Thomas**
And how can I add headings?

**Mathilda**
Just type the heading in the text box and prefix it with # for headings and with ## for subheadings.
Let us now dive into all the cue logic.
Drumroll, please!

# Sounds

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

**Annabel**
Are you ready?
Then lets move to the forest.
Do you hear all the ambience sounds?

```yaml
music:
    file: ambience.mp3
    volume: 0.8
    fadein: 2.513
    fadeout: 2.61
    loop: true
trigger_note:
    ch: 1
    note: 3
```

**Thomas**
When will they be quiet?

**Annabel**
Never.
The sound file is looped.
It will not stop automatically when the next cue is triggered.
You can add triggers, that wil modify or stop it.

```yaml
trigger_note:
    ch: 1
    note: 4
music:
    adjust:
        trigger_note:
            ch: 1
            note: 3
        volume: 0.3
        fadetime: 1
```

**Annabel**
So now, they are much quieter.
If you want them to stop, simply add another cue.

```yaml
trigger_note:
    ch: 1
    note: 5
music:
    adjust:
        trigger_note:
            ch: 1
            note: 3
        fadeout: true
```

# Variants

**Thomas**
My passionate for musicals.
Often, we have different casts.
While one actor wants to sing the song at a higher pitch, the other needs it lower.
I find it very annoying to switch audio files in the show software on prior to each show.

**Mathilda**
We've got you covered!
Just use the "Variant" feature.
Add a cue and put the song for actor A inside.
Click on the "Variant" button.
The cue is copied and shown along the original cue.
You can now choose another audio file.
In the live view, variants will blink so you can't oversee them.
By clicking one of them, you choose which one will be played when you click "GO".

```yaml
music: Abendabschlusslied tief.mp3
note: John
trigger_note:
    ch: 1
    note: 9
```

```yaml
music: Abendabschlusslied hoch.mp3
note: Amy
trigger_note:
    ch: 1
    note: 9
sibling: true
```

# Start - Loop - Finish

**Thomas**
When we do musicals, we often need loops in the middle of a song for parts that sometimes take more time and sometimes less time on stage.
Can I do that too?

**Mathilda**
Of course!
Just use the SLF functionality.
Let me just start the song.

```yaml
music:
    file: Abendabschlusslied start.wav
    volume: 0.8
trigger_note:
    ch: 1
    note: 6
chain_end: {ch: 1, note: 7}
```

**Mathilda**
We can sing some lyrics here.

**Thomas**
Oh yeah!

```yaml
music:
    file: Abendabschlusslied loop.wav
    volume: 0.8
trigger_note:
    ch: 1
    note: 7
loop_outro: {ch: 1, note: 8}
```

**Mathilda**
This is the loop part, where we can talk to each other, act a bit or do some tricks.
As soon as we're done, you can click the next cue or 'GO' in the live view and the song continues.
Your song can have as much parts and loops as you want.
Start - Loop - Bridge - Loop - Finish, no problem.
Of course you can also start or end with a loop.

```yaml
music: Abendabschlusslied finish.wav
trigger_note:
    ch: 1
    note: 8
```

**Thomas** Oh, that's very cool!

**Annabel**
I'm just curious.
What if I need one action at an exact position in the song.
Do I have to click exactly in the right moment?

**Mathilda**
Of course not.
Just use an Auto-Cue.
Add a Cue.
Position the playhead of the cue that should trigger that Auto-Cue to the position you want it to happen.
Then on the cue you want to be triggered, click the Auto-Cue button and select the Cue where you positioned the playhead.
A green line appears.
Bonus: When holding Shift, you can grab the green line and move it to a different position.

```yaml
trigger_note:
    ch: 1
    note: 10
music:
    adjust:
        trigger_note: &ref_0
            ch: 1
            note: 8
        volume: 0.3
        fadetime: 1
auto_trigger:
    trigger_note: {ch: 1, note: 8}
    at: 12.556
```
