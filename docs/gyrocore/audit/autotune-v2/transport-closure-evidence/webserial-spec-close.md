# WICG Web Serial spec excerpts (raw.githubusercontent.com/WICG/serial/main/index.bs, fetched 2026-10-25)
sha256: 298df161d6c89d17a7584f932316e08f8a983885d161167fd4f69e276cd7bbec

## writable write/abort/close algorithms
    1.  Let |promise| be [=a new promise=].
    1.  Assert: |signal| is not [=AbortSignal/aborted=].
    1.  If |chunk| cannot be [=converted to an IDL value=] of type
        {{BufferSource}}, reject |promise| with a {{TypeError}} and return
        |promise|. Otherwise, save the result of the conversion in |source|.
    1.  [=Get a copy of the buffer source=] |source| and save the result in
        |bytes|.
    1.  [=In parallel=], run the following steps:
        1.  Invoke the operating system to write |bytes| to the port.
            Alternately, store the chunk for future coalescing.

            Note: The operating system can return from this operation once
            |bytes| has been queued for transmission rather than after it has
            been transmitted.

            Note: [=this=].{{SerialPort/[[state]]}} becoming `"forgotten"` can
            be treated as if |the port was disconnected|.
        1.  [=Queue a global task=] on the [=relevant global object=] of
            [=this=] using the [=serial port task source=] to run the following
            steps:
            1.  If the chunk was successfully written, or was stored for future
                coalescing, [=resolve=] |promise| with `undefined`.

                Note: [[STREAMS]] specifies that |writeAlgorithm| will only be
                invoked after the {{Promise}} returned by a previous invocation
                of this algorithm has resolved. For efficiency an implementation
                is allowed to resolve this {{Promise}} early in order to
                coalesce multiple chunks waiting in the {{WritableStream}}'s
                internal queue into a single request to the operating system.
            1.  If an operating system error was encountered, [=reject=]
                |promise| with an "{{UnknownError}}" {{DOMException}}.
            1.  If |the port was disconnected|, run the following steps:
                1.  Set [=this=].{{SerialPort/[[writeFatal]]}} to `true`.
                1.  [=Reject=] |promise| with a "{{NetworkError}}"
                    {{DOMException}}.
                1.  Invoke the steps to [=handle closing the writable stream=].
            1.  If |signal| is [=AbortSignal/aborted=], [=reject=] |promise|
                with |signal|'s [=AbortSignal/abort reason=].
    1.  Return |promise|.
1.  Let |abortAlgorithm| be the following steps:
    1.  Let |promise| be [=a new promise=].
    1.  Run the following steps [=in parallel=].
        1.  Invoke the operating system to discard the contents of all software
            and hardware transmit buffers for the port.
        1.  [=Queue a global task=] on the [=relevant global object=] of
            [=this=] using the [=serial port task source=] to run the following
            steps:
            1.  Invoke the steps to [=handle closing the writable stream=].
            1.  [=Resolve=] |promise| with `undefined`.
    1.  Return |promise|.
1.  Let |closeAlgorithm| be the following steps:
    1.  Let |promise| be [=a new promise=].
    1.  Run the following steps [=in parallel=].
        1.  Invoke the operating system to flush the contents of all software
            and hardware transmit buffers for the port.
        1.  [=Queue a global task=] on the [=relevant global object=] of
            [=this=] using the [=serial port task source=] to run the following
            steps:
            1.  Invoke the steps to [=handle closing the writable stream=].
            1.  If |signal| is [=AbortSignal/aborted=], [=reject=] |promise|
                with |signal|'s [=AbortSignal/abort reason=].
            1.  Otherwise, [=resolve=] |promise| with `undefined`.
    1.  Return |promise|.
1.  [=WritableStream/Set up=] |stream| with
    [=WritableStream/set up/writeAlgorithm=] set to |writeAlgorithm|,
    [=WritableStream/set up/abortAlgorithm=] set to |abortAlgorithm|,
    [=WritableStream/set up/closeAlgorithm=] set to |closeAlgorithm|,
    [=WritableStream/set up/highWaterMark=] set to
    [=this=].{{SerialPort/[[bufferSize]]}}, and
    [=WritableStream/set up/sizeAlgorithm=] set to a byte-counting size
    algorithm.
1.  [=AbortSignal/Add=] the following abort steps to |signal|:
    1.  Cause any invocation of the operating system to write to the port to
        return as soon as possible no matter how much data has been written.
1.  Set [=this=].{{SerialPort/[[writable]]}} to |stream|.
1.  Return |stream|.

</div>

<div algorithm>
To <dfn>handle closing the writable stream</dfn> perform the following steps:

1.  Set [=this=].{{SerialPort/[[writable]]}} to `null`.
1.  If [=this=].{{SerialPort/[[readable]]}} is `null` and
    [=this=].{{SerialPort/[[pendingClosePromise]]}} is not `null`, [=resolve=]
    [=this=].{{SerialPort/[[pendingClosePromise]]}} with `undefined`.

</div>

## readable fatal error + handle closing
                to [=handle closing the readable stream=].
            1.  If |the port was disconnected|, run the following steps:
                1.  Set [=this=].{{SerialPort/[[readFatal]]}} to `true`,
                1.  Invoke [=ReadableStream/error=] on
                    [=this=].{{SerialPort/[[readable]]}} with a
                    "{{NetworkError}}" {{DOMException}}.
                1.  Invoke the steps to [=handle closing the readable stream=].
    1.  Return |promise|.
1.  Let |cancelAlgorithm| be the following steps:
    1.  Let |promise| be [=a new promise=].
    1.  Run the following steps [=in parallel=].
        1.  Invoke the operating system to discard the contents of all software
            and hardware receive buffers for the port.
        1.  [=Queue a global task=] on the [=relevant global object=] of
            [=this=] using the [=serial port task source=] to run the following
            steps:
            1.  Invoke the steps to [=handle closing the readable stream=].
            1.  [=Resolve=] |promise| with `undefined`.
    1.  Return |promise|.
1.  [=ReadableStream/Set up with byte reading support=] |stream| with
    <i>[=ReadableStream/set up with byte reading support/pullAlgorithm=]</i> set
    to |pullAlgorithm|, <i>[=ReadableStream/set up with byte reading
    support/cancelAlgorithm=]</i> set to |cancelAlgorithm|, and
    <i>[=ReadableStream/set up with byte reading support/highWaterMark=]</i> set
    to [=this=].{{SerialPort/[[bufferSize]]}}.
1.  Set [=this=].{{SerialPort/[[readable]]}} to |stream|.
1.  Return |stream|.

</div>

<div algorithm>
To <dfn>handle closing the readable stream</dfn> perform the following steps:

1.  Set [=this=].{{SerialPort/[[readable]]}} to `null`.
1.  If [=this=].{{SerialPort/[[writable]]}} is `null` and
    [=this=].{{SerialPort/[[pendingClosePromise]]}} is not `null`, [=resolve=]
    [=this=].{{SerialPort/[[pendingClosePromise]]}} with `undefined`.

</div>

## close()
## <dfn method for="SerialPort">close()</dfn> method ## {#close-method}

<div id="close-example" class="example">
When communication with the port is no longer needed it can be closed and
the associated resources released by the system.

Calling `port.`{{SerialPort/close()}} implicitly invokes
`port.`{{SerialPort/readable}}`.`{{ReadableStream/cancel()}} and
`port.`{{SerialPort/writable}}`.`{{WritableStream/abort()}} in order to clear
any buffered data. If the application has called
`port.`{{SerialPort/readable}}`.`{{ReadableStream/getReader()}} or
`port.`{{SerialPort/writable}}`.`{{WritableStream/getWriter()}} the stream is
locked and the port cannot be closed. This forces the developer to decide how
to handle any read or write operations that are in progress. For example, to
ensure that all buffered data has been transmitted before the port is closed
the application has to await the {{Promise}} returned by
`writer.`{{WritableStreamDefaultWriter/close()}}.

<xmp highlight="js">
const encoder = new TextEncoder();
const writer = port.writable.getWriter();
writer.write(encoder.encode("A long message that will take..."));
await writer.close();
await port.close();
</xmp>

To discard any unsent data the application could instead call
`writer.`{{WritableStreamDefaultWriter/abort()}}.

If a {{TransformStream}} is being piped to `port`.{{SerialPort/writable}} then
waiting for the {{Promise}} returned by
`writer.`{{WritableStreamDefaultWriter/close()}} to resolve is insufficient.
The application has to wait for the pipe chain to close by waiting for the
{{Promise}} returned by {{ReadableStream/pipeTo()}} to resolve instead.

<xmp highlight="js">
const encoder = new TextEncoderStream();
const writableStreamClosed = encoder.readable.pipeTo(port.writable);
const writer = encoder.writable.getWriter();
writer.write("A long message that will take...");
writer.close();
await writableStreamClosed;
await port.close();
</xmp>

If a loop is being used to read chunks from the port, as is done in
<a href="#readable-example">Example 4</a>, then it has to be exited before
calling `port.`{{SerialPort/close()}}.

<xmp highlight="js">
let keepReading = true;
let reader;

async function readUntilClosed() {
  while (port.readable && keepReading) {
    reader = port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // |reader| has been canceled.
          break;
        }
        // Do something with |value|...
      }
    } catch (error) {
      // Handle |error|...
    } finally {
      reader.releaseLock();
    }
  }

  await port.close();
}

const closed = readUntilClosed();

// Sometime later...
keepReading = false;
reader.cancel();
await closed;
</xmp>

Calling `reader.`{{ReadableStreamGenericReader/cancel()}} causes the call to
`reader.`{{ReadableStreamDefaultReader/read()}} to return immediately, exiting
the inner loop and calling
`reader.`{{ReadableStreamDefaultReader/releaseLock()}}. The outer loop then
exits because `keepReading` has been set to `false` and with the stream
unlocked `port.`{{SerialPort/close()}} can complete successfully.

While it is also possible to call `port.`{{SerialPort/close()}} immediately
after awaiting the {{Promise}} returned by
`reader.`{{ReadableStreamGenericReader/cancel()}} it is better to place the
call to `port.`{{SerialPort/close()}} as the last step of `readUntilClosed()`
so that the port is also closed when a fatal error is encountered and
`port.`{{SerialPort/readable}} becomes `null`.
</div>

<div algorithm="SerialPort.close()">
The {{SerialPort/close()}} method steps are:

1.  Let |promise| be [=a new promise=].
1.  If [=this=].{{SerialPort/[[state]]}} is not `"opened"`, reject |promise|
    with an "{{InvalidStateError}}" {{DOMException}} and return |promise|.
1.  Let |cancelPromise| be the result of invoking [=ReadableStream/cancel=] on
    [=this=].{{SerialPort/[[readable]]}} or [=a promise resolved with=]
    `undefined` if [=this=].{{SerialPort/[[readable]]}} is `null`.
1.  Let |abortPromise| be the result of invoking [=WritableStream/abort=] on
    [=this=].{{SerialPort/[[writable]]}} or [=a promise resolved with=]
    `undefined` if [=this=].{{SerialPort/[[writable]]}} is `null`.
1.  Let |pendingClosePromise| be [=a new promise=].
1.  If [=this=].{{SerialPort/[[readable]]}} and
    [=this=].{{SerialPort/[[writable]]}} are `null`, [=resolve=]
    |pendingClosePromise| with `undefined`.
1.  Set [=this=].{{SerialPort/[[pendingClosePromise]]}} to
    |pendingClosePromise|.
1.  Let |combinedPromise| be the result of [=getting a promise to wait for all=]
    with «|cancelPromise|, |abortPromise|, |pendingClosePromise|».
1.  Set [=this=].{{SerialPort/[[state]]}} to `"closing"`.
1.  [=promise/React=] to |combinedPromise|.
    *   If |combinedPromise| was fulfilled, then:
        1.  Run the following steps [=in parallel=]:
            1.  Invoke the operating system to close the serial port and release
                any associated resources.
            1.  Set [=this=].{{SerialPort/[[state]]}} to `"closed"`.
            1.  Set [=this=].{{SerialPort/[[readFatal]]}} and
                [=this=].{{SerialPort/[[writeFatal]]}} to `false`.
            1.  Set [=this=].{{SerialPort/[[pendingClosePromise]]}} to `null`.
            1.  [=Queue a global task=] on the [=relevant global object=] of
                [=this=] using the [=serial port task source=] to [=resolve=]
                |promise| with `undefined`.
    *   If |combinedPromise| was rejected with reason |r|, then:
        1.  Set [=this=].{{SerialPort/[[pendingClosePromise]]}} to `null`.
        1.  [=Queue a global task=] on the [=relevant global object=] of
            [=this=] using the [=serial port task source=] to [=reject=]
            |promise| with |r|.
