var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("BinaryVoting error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("BinaryVoting error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("BinaryVoting contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of BinaryVoting: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to BinaryVoting.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: BinaryVoting not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "1234": {
    "abi": [
      {
        "constant": true,
        "inputs": [],
        "name": "creator",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "id",
            "type": "uint8"
          },
          {
            "name": "option",
            "type": "string"
          }
        ],
        "name": "addOption",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "name": "options",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "mainSignature",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_txid",
            "type": "string"
          }
        ],
        "name": "setTxid",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "txid",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "optionsIndex",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "lockVoting",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "company",
            "type": "address"
          }
        ],
        "name": "votingSupport",
        "outputs": [
          {
            "name": "support",
            "type": "uint256"
          },
          {
            "name": "base",
            "type": "uint256"
          },
          {
            "name": "closingRelativeMajority",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "option",
            "type": "uint8"
          },
          {
            "name": "company",
            "type": "address"
          }
        ],
        "name": "executeOnAction",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [
          {
            "name": "favor",
            "type": "string"
          },
          {
            "name": "against",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "constructor"
      },
      {
        "payable": false,
        "type": "fallback"
      }
    ],
    "unlinked_binary": "0x60606040523461000057604051610bee380380610bee833981016040528051602082015190820191015b5b600060025560038054600160ff199091161761010060a860020a03191661010033600160a060020a0316021790555b6100716000836401000000006103ba6100a682021704565b6100896001826401000000006103ba6100a682021704565b61009e64010000000061070a61017882021704565b5b5050610185565b60035460ff1615156100b757610000565b80600160008460ff1660ff1681526020019081526020016000209080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061011a57805160ff1916838001178555610147565b82800160010185558215610147579182015b8281111561014757825182559160200191906001019061012c565b5b506101689291505b808211156101645760008155600101610150565b5090565b50506002805460010190555b5050565b6003805460ff191690555b565b610a5a806101946000396000f300606060405236156100885763ffffffff60e060020a60003504166302d05d3f811461009a57806315abf3cc146100c35780632bcc79271461011c57806332cbf477146101af578063473aa3881461023c57806349a59f17146102915780635a1c8a301461031e5780636b32111d1461033d578063b16fc1511461034c578063c5e50bb514610385575b34610000576100985b610000565b565b005b34610000576100a76103a6565b60408051600160a060020a039092168252519081900360200190f35b346100005760408051602060046024803582810135601f810185900485028601850190965285855261009895833560ff1695939460449493929092019181908401838280828437509496506103ba95505050505050565b005b346100005761012f60ff6004351661048c565b604080516020808252835181830152835191928392908301918501908083838215610175575b80518252602083111561017557601f199092019160209182019101610155565b505050905090810190601f1680156101a15780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761012f610526565b604080516020808252835181830152835191928392908301918501908083838215610175575b80518252602083111561017557601f199092019160209182019101610155565b505050905090810190601f1680156101a15780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b3461000057610098600480803590602001908201803590602001908080601f016020809104026020016040519081016040528093929190818152602001838380828437509496506105b495505050505050565b005b346100005761012f610676565b604080516020808252835181830152835191928392908301918501908083838215610175575b80518252602083111561017557601f199092019160209182019101610155565b505050905090810190601f1680156101a15780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761032b610704565b60408051918252519081900360200190f35b346100005761009861070a565b005b3461000057610365600160a060020a0360043516610717565b604080519384526020840192909252151582820152519081900360600190f35b346100005761009860ff60043516600160a060020a0360243516610823565b005b6003546101009004600160a060020a031681565b60035460ff1615156103cb57610000565b80600160008460ff1660ff1681526020019081526020016000209080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061042e57805160ff191683800117855561045b565b8280016001018555821561045b579182015b8281111561045b578251825591602001919060010190610440565b5b5061047c9291505b808211156104785760008155600101610464565b5090565b50506002805460010190555b5050565b60016020818152600092835260409283902080548451600294821615610100026000190190911693909304601f810183900483028401830190945283835291929083018282801561051e5780601f106104f35761010080835404028352916020019161051e565b820191906000526020600020905b81548152906001019060200180831161050157829003601f168201915b505050505081565b6004805460408051602060026001851615610100026000190190941693909304601f8101849004840282018401909252818152929183018282801561051e5780601f106104f35761010080835404028352916020019161051e565b820191906000526020600020905b81548152906001019060200180831161050157829003601f168201915b505050505081565b600080546002600019610100600184161502019091160411156105d657610000565b8060009080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061062257805160ff191683800117855561064f565b8280016001018555821561064f579182015b8281111561064f578251825591602001919060010190610634565b5b506106709291505b808211156104785760008155600101610464565b5090565b50505b50565b6000805460408051602060026001851615610100026000190190941693909304601f8101849004840282018401909252818152929183018282801561051e5780601f106104f35761010080835404028352916020019161051e565b820191906000526020600020905b81548152906001019060200180831161050157829003601f168201915b505050505081565b60025481565b6003805460ff191690555b565b604080516000608090910181905290517f706d64c7000000000000000000000000000000000000000000000000000000008152602060048281019182528054600260001961010060018416150201909116046024840181905284938493600160a060020a0388169363706d64c79390928291604490910190849080156107de5780601f106107b3576101008083540402835291602001916107de565b820191906000526020600020905b8154815290600101906020018083116107c157829003601f168201915b505092505050608060405180830381600087803b156100005760325a03f1156100005750506040805180516020820151919092015191955093509150505b9193909250565b60ff8216151561083b576108368161085a565b610488565b60ff82166001141561048857610836816108ad565b610488565b5b5050565b6040805160e160020a636175a1c30281526000600482018190529151600160a060020a0384169263c2eb4386926024808201939182900301818387803b156100005760325a03f115610000575050505b50565b600060006000600060006108c086610717565b509450945085600160a060020a0316638b06fdcf87600160a060020a031663aad0c387306000604051602001526040518263ffffffff1660e060020a0281526004018082600160a060020a0316600160a060020a03168152602001915050602060405180830381600087803b156100005760325a03f11561000057505060405151905060016000604051604001526040518363ffffffff1660e060020a028152600401808381526020018260ff1660ff16815260200192505050604060405180830381600087803b156100005760325a03f1156100005750505060405180519060200180519050925092506402540be40090508381860281156100005704828285028115610000570410156109d457610000565b6040805160e160020a636175a1c3028152600160048201529051600160a060020a0388169163c2eb438691602480830192600092919082900301818387803b156100005760325a03f115610000575050505b5050505050505600a165627a7a723058200cf02d64f60b9f386e6286fc0dfdf7e41e044071013a6367c00532ee69713b350029",
    "events": {},
    "updated_at": 1486123801940,
    "links": {}
  },
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [],
        "name": "creator",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "id",
            "type": "uint8"
          },
          {
            "name": "option",
            "type": "string"
          }
        ],
        "name": "addOption",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "name": "options",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "mainSignature",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_txid",
            "type": "string"
          }
        ],
        "name": "setTxid",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "txid",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "optionsIndex",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "lockVoting",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "company",
            "type": "address"
          }
        ],
        "name": "votingSupport",
        "outputs": [
          {
            "name": "support",
            "type": "uint256"
          },
          {
            "name": "base",
            "type": "uint256"
          },
          {
            "name": "closingRelativeMajority",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "option",
            "type": "uint8"
          },
          {
            "name": "company",
            "type": "address"
          }
        ],
        "name": "executeOnAction",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [
          {
            "name": "favor",
            "type": "string"
          },
          {
            "name": "against",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "constructor"
      },
      {
        "payable": false,
        "type": "fallback"
      }
    ],
    "unlinked_binary": "0x60606040523461000057604051610bee380380610bee833981016040528051602082015190820191015b5b600060025560038054600160ff199091161761010060a860020a03191661010033600160a060020a0316021790555b6100716000836401000000006103ba6100a682021704565b6100896001826401000000006103ba6100a682021704565b61009e64010000000061070a61017882021704565b5b5050610185565b60035460ff1615156100b757610000565b80600160008460ff1660ff1681526020019081526020016000209080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061011a57805160ff1916838001178555610147565b82800160010185558215610147579182015b8281111561014757825182559160200191906001019061012c565b5b506101689291505b808211156101645760008155600101610150565b5090565b50506002805460010190555b5050565b6003805460ff191690555b565b610a5a806101946000396000f300606060405236156100885763ffffffff60e060020a60003504166302d05d3f811461009a57806315abf3cc146100c35780632bcc79271461011c57806332cbf477146101af578063473aa3881461023c57806349a59f17146102915780635a1c8a301461031e5780636b32111d1461033d578063b16fc1511461034c578063c5e50bb514610385575b34610000576100985b610000565b565b005b34610000576100a76103a6565b60408051600160a060020a039092168252519081900360200190f35b346100005760408051602060046024803582810135601f810185900485028601850190965285855261009895833560ff1695939460449493929092019181908401838280828437509496506103ba95505050505050565b005b346100005761012f60ff6004351661048c565b604080516020808252835181830152835191928392908301918501908083838215610175575b80518252602083111561017557601f199092019160209182019101610155565b505050905090810190601f1680156101a15780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761012f610526565b604080516020808252835181830152835191928392908301918501908083838215610175575b80518252602083111561017557601f199092019160209182019101610155565b505050905090810190601f1680156101a15780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b3461000057610098600480803590602001908201803590602001908080601f016020809104026020016040519081016040528093929190818152602001838380828437509496506105b495505050505050565b005b346100005761012f610676565b604080516020808252835181830152835191928392908301918501908083838215610175575b80518252602083111561017557601f199092019160209182019101610155565b505050905090810190601f1680156101a15780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761032b610704565b60408051918252519081900360200190f35b346100005761009861070a565b005b3461000057610365600160a060020a0360043516610717565b604080519384526020840192909252151582820152519081900360600190f35b346100005761009860ff60043516600160a060020a0360243516610823565b005b6003546101009004600160a060020a031681565b60035460ff1615156103cb57610000565b80600160008460ff1660ff1681526020019081526020016000209080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061042e57805160ff191683800117855561045b565b8280016001018555821561045b579182015b8281111561045b578251825591602001919060010190610440565b5b5061047c9291505b808211156104785760008155600101610464565b5090565b50506002805460010190555b5050565b60016020818152600092835260409283902080548451600294821615610100026000190190911693909304601f810183900483028401830190945283835291929083018282801561051e5780601f106104f35761010080835404028352916020019161051e565b820191906000526020600020905b81548152906001019060200180831161050157829003601f168201915b505050505081565b6004805460408051602060026001851615610100026000190190941693909304601f8101849004840282018401909252818152929183018282801561051e5780601f106104f35761010080835404028352916020019161051e565b820191906000526020600020905b81548152906001019060200180831161050157829003601f168201915b505050505081565b600080546002600019610100600184161502019091160411156105d657610000565b8060009080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061062257805160ff191683800117855561064f565b8280016001018555821561064f579182015b8281111561064f578251825591602001919060010190610634565b5b506106709291505b808211156104785760008155600101610464565b5090565b50505b50565b6000805460408051602060026001851615610100026000190190941693909304601f8101849004840282018401909252818152929183018282801561051e5780601f106104f35761010080835404028352916020019161051e565b820191906000526020600020905b81548152906001019060200180831161050157829003601f168201915b505050505081565b60025481565b6003805460ff191690555b565b604080516000608090910181905290517f706d64c7000000000000000000000000000000000000000000000000000000008152602060048281019182528054600260001961010060018416150201909116046024840181905284938493600160a060020a0388169363706d64c79390928291604490910190849080156107de5780601f106107b3576101008083540402835291602001916107de565b820191906000526020600020905b8154815290600101906020018083116107c157829003601f168201915b505092505050608060405180830381600087803b156100005760325a03f1156100005750506040805180516020820151919092015191955093509150505b9193909250565b60ff8216151561083b576108368161085a565b610488565b60ff82166001141561048857610836816108ad565b610488565b5b5050565b6040805160e160020a636175a1c30281526000600482018190529151600160a060020a0384169263c2eb4386926024808201939182900301818387803b156100005760325a03f115610000575050505b50565b600060006000600060006108c086610717565b509450945085600160a060020a0316638b06fdcf87600160a060020a031663aad0c387306000604051602001526040518263ffffffff1660e060020a0281526004018082600160a060020a0316600160a060020a03168152602001915050602060405180830381600087803b156100005760325a03f11561000057505060405151905060016000604051604001526040518363ffffffff1660e060020a028152600401808381526020018260ff1660ff16815260200192505050604060405180830381600087803b156100005760325a03f1156100005750505060405180519060200180519050925092506402540be40090508381860281156100005704828285028115610000570410156109d457610000565b6040805160e160020a636175a1c3028152600160048201529051600160a060020a0388169163c2eb438691602480830192600092919082900301818387803b156100005760325a03f115610000575050505b5050505050505600a165627a7a723058200cf02d64f60b9f386e6286fc0dfdf7e41e044071013a6367c00532ee69713b350029",
    "events": {},
    "updated_at": 1486036778439,
    "links": {}
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "BinaryVoting";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.BinaryVoting = Contract;
  }
})();