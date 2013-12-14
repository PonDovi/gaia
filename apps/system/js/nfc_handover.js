/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

/* Copyright © 2013, Deutsche Telekom, Inc. */

'use strict';

/*******************************************************************************
 * HandoverManager handles handovers from other Bluetooth devices according
 * to the specification of the NFC Forum (Document:
 * NFCForum-TS-ConnectionHandover_1_2.doc). HandoverManager exports five
 * functions:
 * - handleHandoverRequest: handle NDEF Handover Request messages
 * - handleHandoverSelect: handle NDEF Handover Select message
 * - handleFileTransfer: trigger a file transfer with a remote device via BT.
 * - isHandoverInProgress: returns true if a handover is in progress.
 * - transferComplete: tell HandoverManager that a file transfer completed.
 */
function HandoverManager() {

  this.bluetooth = window.navigator.mozBluetooth;
  this.nfc = window.navigator.mozNfc;

  this.defaultAdapter = null;

  var DEBUG = false;
  var self = this;
  var settings = window.navigator.mozSettings;

  /*****************************************************************************
   *****************************************************************************
   * Utility functions/classes
   *****************************************************************************
   ****************************************************************************/

  /**
   * Debug method
   */
  function debug(msg, optObject) {
    if (DEBUG) {
      var output = '[DEBUG] SYSTEM NFC-HANDOVER: ' + msg;
      if (optObject) {
        output += JSON.stringify(optObject);
      }
      if (typeof dump !== 'undefined') {
        dump(output);
      } else {
        console.log(output);
      }
    }
  }

  /*****************************************************************************
   * NdefUtils: Some common utilities functions.
   */
  var NdefUtils = {

    fromUTF8: function fromUTF8(str) {
      var buf = new Uint8Array(str.length);
      for (var i = 0; i < str.length; i++) {
        buf[i] = str.charCodeAt(i);
      }
      return buf;
    },

    equalArrays: function equalArrays(a1, a2) {
      if (a1.length != a2.length) {
        return false;
      }
      for (var i = 0; i < a1.length; i++) {
        if (a1[i] != a2[i]) {
          return false;
        }
      }
      return true;
    },

    toUTF8: function toUTF8(a) {
      var str = '';
      for (var i = 0; i < a.length; i++) {
        str += String.fromCharCode(a[i]);
      }
      return str;
    }

  };

  /*****************************************************************************
   * NdefConsts: some NDEF-related constants as defined by the NFC Forum.
   */
  var NdefConsts = {
    MB: 1 << 7,
    ME: 1 << 6,
    CF: 1 << 5,
    SR: 1 << 4,
    IL: 1 << 3,
    TNF: 0x07,

    tnf_well_known: 0x01,
    tnf_mime_media: 0x02,

    rtd_alternative_carrier: 0,
    rts_collision_resolution: 0,
    rtd_handover_carrier: 0,
    rtd_handover_request: 0,
    rtd_handover_select: 0,

    init: function init() {
      this.rtd_alternative_carrier = NdefUtils.fromUTF8('ac');
      this.rtd_collision_resolution = NdefUtils.fromUTF8('cr');
      this.rtd_handover_carrier = NdefUtils.fromUTF8('Hc');
      this.rtd_handover_request = NdefUtils.fromUTF8('Hr');
      this.rtd_handover_select = NdefUtils.fromUTF8('Hs');
    }
  };

  NdefConsts.init();

  /*****************************************************************************
   * Buffer: helper class that makes it easier to read from a Uint8Array.
   * @param {Uint8Array} uint8array The Uint8Array instance to wrap.
   */
  function Buffer(uint8array) {
    /*
     * It is weird that the uint8array parameter (which is of type Uint8Array)
     * needs to be wrapped in another Uint8Array instance. Running the code
     * with node.js does not require this, but when running it is Gaia it will
     * later complain that subarray is not a function when the parameter is
     * not wrapped.
     */
    this.uint8array = new Uint8Array(uint8array);
    this.offset = 0;
  }

  Buffer.prototype.getOctet = function getOctet() {
    if (this.offset == this.uint8array.length) {
      throw 'Buffer too small';
    }
    return this.uint8array[this.offset++];
  };

  Buffer.prototype.getOctetArray = function getOctetArray(len) {
    if (this.offset + len > this.uint8array.length) {
      throw 'Buffer too small';
    }
    var a = this.uint8array.subarray(this.offset, this.offset + len);
    this.offset += len;
    return a;
  };

  Buffer.prototype.skip = function skip(len) {
    if (this.offset + len > this.uint8array.length) {
      throw 'Buffer too small';
    }
    this.offset += len;
  };

  /*****************************************************************************
   * NdefCodec: Coding/decoding of NDEF messages (NFCForum-TS-NDEF_1.0)
   */
  var NdefCodec = {

    /**
     * parse(): parses a NDEF message contained in a Buffer instance.
     * Usage:
     *   var buf = new Buffer(<Uint8Array that contains the raw NDEF message>);
     *   var ndef = NdefCodec.parse(buf);
     *
     * 'null' is returned if the message could not be parsed. Otherwise the
     * result is an array of MozNdefRecord instances.
     */
    parse: function parse(buffer) {
      this.buffer = buffer;
      try {
        return NdefCodec.doParse();
      } catch (err) {
        debug(err);
        return null;
      }
    },

    doParse: function doParse() {
      var records = new Array();
      var isFirstRecord = true;
      do {
        var firstOctet = this.buffer.getOctet();
        if (isFirstRecord && !(firstOctet & NdefConsts.MB)) {
          throw 'MB bit not set in first NDEF record';
        }
        if (!isFirstRecord && (firstOctet & NdefConsts.MB)) {
          throw 'MB can only be set for the first record';
        }
        if (firstOctet & NdefConsts.CF) {
          throw 'Cannot deal with chunked records';
        }
        records.push(NdefCodec.parseNdefRecord(firstOctet));
        isFirstRecord = false;
      } while (!(firstOctet & NdefConsts.ME));
      return records;
    },

    parseNdefRecord: function parseNdefRecord(firstOctet) {
      var tnf = firstOctet & NdefConsts.TNF;
      var typeLen = this.buffer.getOctet();
      var payloadLen = this.buffer.getOctet();
      if (!(firstOctet & NdefConsts.SR)) {
        for (var i = 0; i < 3; i++) {
          payloadLen <<= 8;
          payloadLen |= this.buffer.getOctet();
        }
      }
      var idLen = 0;
      if (firstOctet & NdefConsts.IL) {
        idLen = this.buffer.getOctet();
      }
      var type = this.buffer.getOctetArray(typeLen);
      var id = this.buffer.getOctetArray(idLen);
      var payload = this.buffer.getOctetArray(payloadLen);
      return new MozNdefRecord(tnf, type, id, payload);
    }
  };

  /*****************************************************************************
   * NdefHandoverCodec: Coding/decoding of NDEF Handover messages.
   * (NFCForum-TS-ConnectionHandover_1_2.doc)
   */
  var NdefHandoverCodec = {

    /**
     * parse(): parse a NDEF message containing a handover message. 'ndefMsg'
     * is an Array of MozNdefRecord. Only 'Hr' and 'Hs' records are parsed.
     * The result is an object with the following attributes:
     *   - type: either 'Hr' (Handover Request) or 'Hs' (Handover Select)
     *   - majorVersion
     *   - minorVersion
     *   - cr: Collision resolution value. Tthis value is only present
     *         for a 'Hr' record
     *   - ac: Array of Alternate Carriers. Each object of this array has
     *         the following attributes:
     *           - cps: Carrier Power State
     *           - cdr: Carrier Data Record: MozNdefRecord containing further
     *                  info
     */
    parse: function parse(ndefMsg) {
      try {
        return NdefHandoverCodec.doParse(ndefMsg);
      } catch (err) {
        debug(err);
        return null;
      }
    },

    doParse: function doParse(ndefMsg) {
      var record = ndefMsg[0];
      var buffer = new Buffer(record.payload);
      var h = {};
      var version = buffer.getOctet();
      h.majorVersion = version >>> 4;
      h.minorVersion = version & 0x0f;
      h.ac = [];

      var embeddedNdef = NdefCodec.parse(buffer);
      if (embeddedNdef == null) {
        throw 'Could not parse embedded NDEF in Hr/Hs record';
      }

      if (record.tnf != NdefConsts.tnf_well_known) {
        throw 'Expected Well Known TNF in Hr/Hs record';
      }

      if (NdefUtils.equalArrays(record.type, NdefConsts.rtd_handover_select)) {
        h.type = 'Hs';
        this.parseAcRecords(h, ndefMsg, embeddedNdef, 0);
      } else if (NdefUtils.equalArrays(record.type,
                 NdefConsts.rtd_handover_request)) {
        h.type = 'Hr';
        var crr = embeddedNdef[0];
        if (!NdefUtils.equalArrays(crr.type,
            NdefConsts.rtd_collision_resolution)) {
          throw 'Expected Collision Resolution Record';
        }
        if (crr.payload.length != 2) {
          throw 'Expected random number in Collision Resolution Record';
        }
        h.cr = (crr.payload[0] << 8) | crr.payload[1];
        this.parseAcRecords(h, ndefMsg, embeddedNdef, 1);
      } else {
        throw 'Can only handle Hr and Hs records for now';
      }
      return h;
    },

    parseAcRecords: function parseAcRecords(h, ndef, acNdef, offset) {
      for (var i = offset; i < acNdef.length; i++) {
        var record = acNdef[i];
        if (NdefUtils.equalArrays(record.type,
            NdefConsts.rtd_alternative_carrier)) {
          h.ac.push(this.parseAC(record.payload, ndef));
        } else {
          throw 'Can only parse AC record within Hs';
        }
      }
    },

    parseAC: function parseAC(ac, ndef) {
      var b = new Buffer(ac);
      var ac = {};
      ac.cps = b.getOctet() & 0x03;
      var cdrLen = b.getOctet();
      var cdr = b.getOctetArray(cdrLen);
      ac.cdr = this.findNdefRecordWithId(cdr, ndef);
      return ac;
    },

    findNdefRecordWithId: function findNdefRecordWithId(id, ndef) {
      for (var i = 0; i < ndef.length; i++) {
        var record = ndef[i];
        if (NdefUtils.equalArrays(id, record.id)) {
          return record;
        }
      }
      throw 'Could not find record with id';
    },

    /**
     * searchForBluetoothAC(): searches a Handover message for an
     * Alternative Carrier that contains a Bluetooth profile.
     * Parameter 'h' is the result of the parse() function.
     * Returns null if no Bluetooth AC could be found, otherwise
     * returns a MozNdefRecord.
     */
    searchForBluetoothAC: function searchForBluetoothAC(h) {
      for (var i = 0; i < h.ac.length; i++) {
        var cdr = h.ac[i].cdr;
        if (cdr.tnf == NdefConsts.tnf_mime_media) {
          var mimeType = NdefUtils.toUTF8(cdr.type);
          if (mimeType == 'application/vnd.bluetooth.ep.oob') {
            return cdr;
          }
        }
      }
      return null;
    },

    /**
     * parseBluetoothSSP(): Parses a Carrier Data Record that contains a
     * Bluetooth Secure Simple Pairing record (NFCForum-AD-BTSSP_1.0).
     * 'cdr': Carrier Data Record. Returns an object with the following
     * attributes:
     *   - mac: MAC address (string representation)
     *   - localName: Local name (optional)
     */
    parseBluetoothSSP: function parseBluetoothSSP(cdr) {
      var btssp = {};
      var buf = new Buffer(cdr.payload);
      var btsspLen = buf.getOctet() | (buf.getOctet() << 8);
      var mac = '';
      for (var i = 0; i < 6; i++) {
        if (mac.length > 0) {
          mac = ':' + mac;
        }
        var o = buf.getOctet();
        mac = o.toString(16).toUpperCase() + mac;
        if (o < 16) {
          mac = '0' + mac;
        }
      }
      btssp.mac = mac;
      while (buf.offset != cdr.payload.length) {
        // Read OOB value
        var len = buf.getOctet() - 1 /* 'len' */;
        var type = buf.getOctet();
        switch (type) {
        case 0x08:
        case 0x09:
          // Local name
          var n = buf.getOctetArray(len);
          btssp.localName = NdefUtils.toUTF8(n);
          break;
        default:
          // Ignore OOB value
          buf.skip(len);
          break;
        }
      }
      return btssp;
    },

    /**
     * encodeHandoverRequest(): returns a NDEF message containing a Handover
     * Request. Only a Bluetooth AC will be added to the Handover Request.
     * 'mac': MAC address (string). 'cps': Carrier Power State.
     * 'rnd': Random value for collision resolution
     */
    encodeHandoverRequest: function encodeHandoverRequest(mac, cps, rnd) {
      var macVals = mac.split(':');
      if (macVals.length != 6) {
        return null;
      }
      var m = new Array();
      for (var i = 5; i >= 0; i--) {
        m.push(parseInt(macVals[i], 16));
      }
      var rndLSB = rnd & 0xff;
      var rndMSB = rnd >>> 8;
      var hr = [new MozNdefRecord(1,
                                  new Uint8Array([72, 114]),
                                  new Uint8Array([]),
                                  new Uint8Array([18, 145, 2, 2, 99, 114,
                                                  rndMSB, rndLSB, 81, 2, 4, 97,
                                                  99, cps, 1, 98, 0])),
                new MozNdefRecord(2,
                                  new Uint8Array([97, 112, 112, 108, 105, 99,
                                                  97, 116, 105, 111, 110, 47,
                                                  118, 110, 100, 46, 98, 108,
                                                  117, 101, 116, 111, 111, 116,
                                                  104, 46, 101, 112, 46, 111,
                                                  111, 98]),
                                  new Uint8Array([98]),
                                  new Uint8Array([8, 0, m[0], m[1], m[2], m[3],
                                                  m[4], m[5]]))];
      return hr;
    },

    encodeHandoverSelect: function encodeHandoverSelect(mac, cps) {
      var macVals = mac.split(':');
      if (macVals.length != 6) {
        return null;
      }
      var m = new Array();
      for (var i = 5; i >= 0; i--) {
        m.push(parseInt(macVals[i], 16));
      }
      var hs = [new MozNdefRecord(NdefConsts.tnf_well_known,
                                  NdefConsts.rtd_handover_select,
                                  new Uint8Array([]),
                                  new Uint8Array([0x12, 0xD1, 0x02, 0x04, 0x61,
                                                0x63, cps, 0x01, 0x30, 0x00])),
                new MozNdefRecord(NdefConsts.tnf_mime_media,
                                  new Uint8Array([97, 112, 112, 108, 105, 99,
                                                  97, 116, 105, 111, 110, 47,
                                                  118, 110, 100, 46, 98, 108,
                                                  117, 101, 116, 111, 111, 116,
                                                  104, 46, 101, 112, 46, 111,
                                                  111, 98]),
                                  new Uint8Array([0x30]),
                                  new Uint8Array([8, 0, m[0], m[1], m[2], m[3],
                                                  m[4], m[5]]))];
      return hs;
    }
  };

  /*****************************************************************************
   *****************************************************************************
   * Event handlers
   *****************************************************************************
   ****************************************************************************/


  /*
   * actionQueue keeps a list of actions that need to be performed after
   * Bluetooth is turned on.
   */
  this.actionQueue = new Array();

  /*
   * sendFileRequest is set whenever an app called peer.sendFile(blob).
   * It will be inspected in the handling of Handover Select messages
   * to distinguish between static and negotiated handovers.
   */
  this.sendFileRequest = null;

  /*
   * remoteMAC is the MAC address of the remote device during a file transfer.
   */
  this.remoteMAC = null;

  /*
   * settingsNotified is used to prevent triggering Settings multiple times.
   */
  this.settingsNotified = false;

  this.bluetooth.addEventListener('adapteradded', function() {
    debug('adapteradded');
    var req = self.bluetooth.getDefaultAdapter();
    req.onsuccess = function bt_getAdapterSuccess() {
      self.settingsNotified = false;
      self.defaultAdapter = req.result;
      debug('MAC address: ' + self.defaultAdapter.address);
      debug('MAC name: ' + self.defaultAdapter.name);
      /*
       * Call all actions that have queued up while Bluetooth
       * was turned on.
       */
      for (var i = 0; i < self.actionQueue.length; i++) {
        var action = self.actionQueue[i];
        action.callback.apply(null, action.args);
      }
      self.actionQueue = new Array();
    };
  });

  /*****************************************************************************
   *****************************************************************************
   * Private helper functions
   *****************************************************************************
   ****************************************************************************/

  /*
   * Performs an action once Bluetooth is enabled. If Bluetooth is disabled,
   * it is enabled and the action is queued. If Bluetooth is already enabled,
   * performs the action directly.
   */
  function doAction(action) {
    if (!self.bluetooth.enabled) {
      debug('Bluetooth: not yet enabled');
      self.actionQueue.push(action);
      if (self.settingsNotified == false) {
        settings.createLock().set({'bluetooth.enabled': true});
        self.settingsNotified = true;
      }
    } else {
      action.callback.apply(null, action.args);
    }
  }

  function getBluetoothMAC(ndef) {
    var handover = NdefHandoverCodec.parse(ndef);
    if (handover == null) {
      // Bad handover message. Just ignore.
      debug('Bad handover messsage');
      return null;
    }
    var btsspRecord = NdefHandoverCodec.searchForBluetoothAC(handover);
    if (btsspRecord == null) {
      // There is no Bluetooth Alternative Carrier record in the
      // Handover Select message. Since we cannot handle WiFi Direct,
      // just ignore.
      debug('No BT AC');
      return null;
    }
    var btssp = NdefHandoverCodec.parseBluetoothSSP(btsspRecord);
    return btssp.mac;
  }

  function doPairing(mac, onsuccess, onerror) {
    debug('doPairing: ' + mac);
    if (self.defaultAdapter == null) {
      // No BT
      debug('No defaultAdapter');
      return;
    }
    var req = self.defaultAdapter.pair(mac);
    req.onsuccess = onsuccess;
    req.onerror = onerror;
  }

  function doFileTransfer(mac) {
    debug('doFileTransfer');
    if (self.sendFileRequest == null) {
      // Nothing to do
      debug('No pending sendFileRequest');
      return;
    }
    self.remoteMAC = mac;
    var onsuccess = function() {
      var blob = self.sendFileRequest.blob;
      var mac = self.remoteMAC;
      debug('Send blob to ' + mac);
      BluetoothTransfer.sendFile(mac, blob);
    };
    var onerror = function() {
      self.sendFileRequest.onerror();
      self.sendFileRequest = null;
      self.remoteMAC = null;
    };
    doPairing(mac, onsuccess, onerror);
  }

  function doHandoverRequest(ndef, session) {
    debug('doHandoverRequest');
    var mac = getBluetoothMAC(ndef);
    if (mac == null) {
      return;
    }

    self.remoteMAC = mac;
    var nfcPeer = self.nfc.getNFCPeer(session);
    var carrierPowerState = self.bluetooth.enabled ? 1 : 2;
    var mymac = self.defaultAdapter.address;
    var hs = NdefHandoverCodec.encodeHandoverSelect(mymac, carrierPowerState);
    var req = nfcPeer.sendNDEF(hs);
    req.onsuccess = function() {
      debug('sendNDEF(hs) succeeded');
      doPairing(mac);
    };
    req.onerror = function() {
      debug('sendNDEF(hs) failed');
      self.remoteMAC = null;
    };
  };

  function initiateFileTransfer(session, blob, requestId) {
    /*
     * Initiate a file transfer by sending a Handover Request to the
     * remote device.
     */
    var onsuccess = function() {
      dispatchSendFileStatus(0);
    };
    var onerror = function() {
      dispatchSendFileStatus(1);
    };
    self.sendFileRequest = {session: session, blob: blob, requestId: requestId,
                            onsuccess: onsuccess, onerror: onerror};
    var nfcPeer = self.nfc.getNFCPeer(session);
    var carrierPowerState = self.bluetooth.enabled ? 1 : 2;
    var rnd = Math.floor(Math.random() * 0xffff);
    var mac = self.defaultAdapter.address;
    var hr = NdefHandoverCodec.encodeHandoverRequest(mac, carrierPowerState,
                                                     rnd);
    var req = nfcPeer.sendNDEF(hr);
    req.onsuccess = function() {
      debug('sendNDEF(hr) succeeded');
    };
    req.onerror = function() {
      debug('sendNDEF(hr) failed');
      onerror();
      self.sendFileRequest = null;
    };
  };

  function dispatchSendFileStatus(status) {
    debug('In initiateFileTransfer ' + status);
    var detail = {
                   status: status,
                   requestId: self.sendFileRequest.requestId,
                   sessionToken: self.sendFileRequest.session
                 };
    var evt = new CustomEvent('nfc-send-file-status', {
      bubbles: true, cancelable: true,
      detail: detail
    });
    window.dispatchEvent(evt);
  };

  window.navigator.mozSetMessageHandler('nfc-manager-send-file', function(msg) {
    debug('In New event nfc-manager-send-file' + JSON.stringify(msg));
    self.handleFileTransfer(msg.sessionToken, msg.blob, msg.requestId);
  });

  /*****************************************************************************
   *****************************************************************************
   * Handover API
   *****************************************************************************
   ****************************************************************************/

  this.handleHandoverSelect = function handleHandoverSelect(ndef) {
    debug('handleHandoverSelect');
    var mac = getBluetoothMAC(ndef);
    if (mac == null) {
      return;
    }
    if (this.sendFileRequest != null) {
      // This is the response to a file transfer request (negotiated handover)
      doAction({callback: doFileTransfer, args: [mac]});
    } else {
      // This is a static handover
      debug('Pair with: ' + mac);
      var onsuccess = function() { debug('Pairing succeeded'); };
      var onerror = function() { debug('Pairing failed'); };
      doAction({callback: doPairing, args: [mac, onsuccess, onerror]});
    }
  };

  this.handleHandoverRequest =
    function handleHandoverRequest(ndef, session) {
      debug('handleHandoverRequest');
      doAction({callback: doHandoverRequest, args: [ndef, session]});
  };

  this.handleFileTransfer =
    function handleFileTransfer(session, blob, requestId) {
      debug('handleFileTransfer');
      doAction({callback: initiateFileTransfer, args: [session, blob,
                                                       requestId]});
  };

  this.isHandoverInProgress = function isHandoverInProgress() {
    return this.remoteMAC != null;
  };

  this.transferComplete = function transferComplete(succeeded) {
    debug('transferComplete');
    if ((this.defaultAdapter != null) && (this.remoteMAC != null)) {
      this.defaultAdapter.unpair(this.remoteMAC);
      this.remoteMAC = null;
    }
    if (this.sendFileRequest != null) {
      // Completed an outgoing send file request. Call onsuccess/onerror
      if (succeeded == true) {
        this.sendFileRequest.onsuccess();
      } else {
        this.sendFIleRequest.onerror();
      }
      this.sendFileRequest = null;
    }
  };
}

var handoverManager = new HandoverManager();
